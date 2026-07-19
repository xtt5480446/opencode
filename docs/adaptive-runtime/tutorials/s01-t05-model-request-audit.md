# S01-T05：模型请求审计与准入

## 先说结论

本任务新增 `AdaptiveModelAudit`，把一次模型请求是否有资格执行，以及 Task 最终能否声明“全程使用同一模型”，变成 SQLite 中可复查的事实。`admit` 在一个事务里核对当前 Task、已认领的 Agent generation、ContextManifest 归属、完整 ModelPolicy 和 retry lineage，全部成立后才插入 `admitted`；`streaming` 与 `settle` 通过条件更新持久化状态，`verify` 则离线检查未结算请求、resolved identity、variant、policy hash 与 context limit。

它没有调用模型、解析 provider catalog、组装上下文或执行 retry。模型解析仍由 S01-T04 的现有入口负责，真正的 provider stream 和三条 terminal finalizer 路径由后续 S01-T08 Model Gateway 接入。

## 它在当前 Milestone 中的位置

S01-T03 已经提供 Task、Agent、Manifest 与 model request 表，S01-T04 已经提供固定 model ref 的精确解析；本任务在两者之间建立强制审计边界。短上下文 Agent 不必相信自己的 transcript 来证明模型一致性，Controller 重启后也能只读数据库重新计算 `ValidityProof`。这直接服务 benchmark 公平性：只要出现混用模型、variant 漂移、超限 context 或未结算请求，最终结果就只能标记为 `INVALID_MODEL_MIXING`。

```text
S01-T03 durable store + S01-T04 exact model resolution
  → S01-T05 transactional admission and offline model audit
  → S01-T08 audited Model Gateway and final benchmark validity
```

## OpenCode baseline 与复用边界

修改前，Adaptive 代码可以通过 `AdaptiveStore.insertModelRequest` 保存一条 policy snapshot，再用 `settleModelRequest` 从 `admitted|streaming` 推进到 terminal 状态。Store 会检查 Manifest 引用和基础 retry Task 归属，但它刻意不拥有 lease authorization、Task policy equality、resolved model identity 或最终公平性判断；这些边界在 S01-T03 中就留给了本任务。

最终实现直接复用 `Database.Service`、T03 的四张 Drizzle table、`AdaptiveTask.ModelPolicy` 和 `AdaptiveModelPolicy.assertEqual`。`AdaptiveModelAudit.node` 依赖现有 `AdaptiveStore.node`，因此应用只组合一个 Core store 和一个数据库。没有新增数据库、provider registry、model resolver、generic transaction API 或执行框架。

`adaptive_model_request` 现在明确区分两组事实：`provider_id/model_id/variant/effective_context_limit` 与 reserves/hash 是 admission 时的 immutable policy snapshot；nullable `resolved_provider_id/resolved_model_id/resolved_variant/resolved_effective_context_limit` 是 terminal settlement 时的实际观测。forward migration 给既有 T03 表增加后者并保持旧 row 原值，旧 terminal row 的 resolved observation 合理地保持 `NULL`。这避免 invalid model drift 被误报成 policy 数据损坏，也允许实际 context limit 低于 policy reserves 时仍把证据安全落盘。

## 最终实现

`AdmissionInput` 携带 Request、Task、Agent、generation、Manifest、可选 `retryOf` 与完整 ModelPolicy。`admit` 先在同一数据库事务中读取 Task、Agent、Manifest 和 retry parent：Agent 必须属于 Task、generation 必须是当前值、lease 必须仍有效且状态为 `starting|running`；Manifest 必须属于同一 Task/Agent/generation；调用方 policy 的 effective limit 与其他 immutable fields/hash 必须和 Task 完全一致。retry parent 至少已经存在，并且属于同一 Task、Agent 和 policy hash。验收要求允许 A 仍为 `admitted` 时创建 `retryOf: A` 的 B，因此本层不额外要求 parent terminal。任何检查失败都会通过 typed admission error 回滚事务，不留下 rejected row。

准入错误按调用方可恢复的原因拆分为 `MissingStateError`、`StaleGenerationError`、`AgentTaskMismatchError`、`AgentNotClaimedError`、`ManifestMismatchError`、`PolicyMismatchError`、`InvalidRetryLineageError` 与 `DuplicateRequestError`。错误只包含 ID、generation 和稳定 reason，不携带 owner、credential、Manifest 正文或 provider failure 原文。

`streaming` 只接受 `admitted`，`settle` 只接受 `admitted|streaming`，后者在同一 CAS update 中写 `resolved_*`、usage、failure summary 和 completion time，绝不修改 admission policy columns。`AdaptiveStore.ModelRequestRecord.modelPolicy` 因而始终可重建并通过 canonical hash 检查；当 observation 存在时，独立的可选 `resolved` record 返回实际 provider/model/variant/limit。通用 `AdaptiveStore.settleModelRequest` 保持 source-compatible，不伪造解析结果，因此它结算的 row 没有 `resolved`。缺失 Request 与非法重复 transition 分别返回 `RequestNotFoundError` 和 `InvalidTransitionError`，无效 token/limit 返回 `InvalidSettlementError`。

`verify` 按 Request ID 排序证据，并按固定类别生成 reasons。它先从 admission columns 分别重建 Task 与每条 Request 的完整 ModelPolicy，对每个 snapshot 执行 canonical self-check，再用 `AdaptiveModelPolicy.assertEqual` 比较每条 canonical Request 与 Task。检查失败不会从 `verify` 抛出：Task 或 Request 的 fields/hash preimage 不自洽时生成 `CORRUPT_TASK_POLICY:<TaskID>` 或 `CORRUPT_REQUEST_POLICY:<RequestID>`；自洽但完整 policy 与 Task 不同则生成 `REQUEST_POLICY_MISMATCH:<RequestID>`。

零请求、`admitted|streaming`、terminal row 缺少 resolved observation、多个 provider/model identity、单一 identity 偏离 Task、resolved variant 偏离 Task、多个 policy hash、resolved effective context limit 高于 Task policy 同样会返回 `{ valid: false, code: "INVALID_MODEL_MIXING" }`。只有 Task 与全部 Request policy canonical 且完全相等、至少一条请求、全部 terminal 且都有 observation、一个正确 identity/variant/hash 并且没有超限 context 时，才返回 exact provider/model/policy/count 的 valid proof。

```text
AdmissionInput
  → one transaction: Task → claimed Agent → Manifest → policy → retry parent
  → insert admitted row with immutable policy snapshot
  → CAS streaming
  → CAS terminal + separate resolved_* observation/usage
  → canonical Task/Request policies + deterministic resolved verification
  → ValidityProof
```

## 推荐代码阅读路线

1. `AdaptiveModelAudit.Interface`：先理解 `admit`、`streaming`、`settle`、`verify` 四个公开边界和输入输出。
2. `AdaptiveModelAudit.admit`：跟随一个事务中的校验顺序，确认所有 expected mismatch 都在 insert 之前返回 typed error。
3. `AdaptiveStore.ModelRequestRecord` 与 `requestRecord`：先看 immutable `modelPolicy` 与可选 `resolved` 怎样从同一 row 的两组列独立重建。
4. `AdaptiveModelAudit.settle` 与 `AdaptiveModelAudit.verify`：理解实际 observation 怎样只落到 `resolved_*`，以及 reasons 怎样稳定排序。
5. `model-audit.test.ts` 与 resolved observation migration test：从 composability、T03 upgrade、model mixing、缺失 observation 和 terminal CAS 观察完整契约。

## 术语释义

**Admission** 的直觉是“拿到执行模型请求的门票”；工程上是副作用发生前的一组授权与一致性检查；本项目中它还必须和插入 `admitted` row 位于同一 transaction，避免检查后状态漂移或失败尝试留下审计假象。

**CAS transition** 是 compare-and-set 状态推进：SQL `WHERE` 同时比较 Request ID 和允许的当前 status，只有匹配的一行能更新。这里它保证 `admitted → streaming → terminal` 不会被重复 streaming 或第二次 settlement 覆盖。

**Resolved observation** 是 provider catalog 与 route 实际解析出来的 provider、model、variant 和 effective context limit，不是调用方声称想用的 policy。它存放在独立 `resolved_*` 列；policy snapshot 说明“准入允许什么”，observation 说明“实际准备执行什么”。`verify` 比较两者，因而 invalid evidence 可读、同 provider/model 但不同 reasoning variant 也无法漏过。

**ValidityProof** 是从 durable rows 重新计算的最终判定。它不是运行时内存里的布尔标记；进程重启后仍可得到相同 requests 数量和按稳定顺序排列的 invalid reasons，供 benchmark final log 使用。

## 测试看护逻辑

| 风险                                  | 测试方法                               | 关键断言                                                                     | 证明范围                                     |
| ------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| rejected admission 留下 row           | wrong generation/Manifest/policy cases | 每次 typed error 后 count 仍为 `0`                                           | 校验与 insert 同一事务                       |
| retry 偷换 Task 或 policy             | exact retry lineage test               | B 指向 A；cross Task/policy count 不变                                       | parent 同 Task/Agent/hash                    |
| provider/model 混用却有效             | two resolved identities test           | stable sorted `MULTIPLE_MODEL_IDENTITIES`                                    | settled observation 可离线比较               |
| invalid observation 破坏 Store 可读性 | immutable policy beside resolved test  | 原 `modelPolicy` 完整返回且 `resolved` 独立返回漂移值                        | policy snapshot 与事实观测可组合读取         |
| 未结算请求被遗漏                      | admitted and streaming test            | reason 含 `UNSETTLED_MODEL_REQUEST:<RequestID>`                              | 两种 nonterminal 状态均 fail closed          |
| terminal row 缺失事实观测             | missing resolved observation test      | reason 含 `MISSING_RESOLVED_MODEL_OBSERVATION:<RequestID>`                   | generic settlement 不能伪装 audit 完整       |
| reasoning variant 漂移                | resolved variant test                  | `MODEL_VARIANT_MISMATCH` 含 Request ID 与两侧 variant                        | 同 model 的 variant 仍受 policy 约束         |
| policy/context 漂移                   | zero/context/hash test                 | `NO_MODEL_REQUEST`、超限和 multiple hash reasons                             | verifier 不只统计 model ID                   |
| corrupt policy 被错误认证             | corrupt Task/Request policy tests      | `CORRUPT_*_POLICY`，且不会返回 valid 或抛出                                  | hash 必须是全部执行字段的 canonical preimage |
| 自洽 Request policy 偷换 Task policy  | complete Request policy mismatch test  | `REQUEST_POLICY_MISMATCH:<RequestID>`                                        | 不只比较 hash，完整执行策略必须相等          |
| transition 被重复覆盖                 | three terminal paths test              | durable status/time/usage；missing/terminal/repeated streaming typed failure | 三条 Task 8 finalizer 路径都有 CAS           |
| 正常 retry 被误杀                     | one-model lineage test                 | exact provider/model/hash/count 的 valid proof                               | terminal 成败不影响模型一致性                |
| T03 升级丢失 request                  | existing T03 migration test            | 原 policy/status/usage 保留，四个 `resolved_*` 为 `NULL`                     | forward migration 无损兼容旧库               |

这些测试使用真实 in-memory SQLite 和现有 Store，不模拟 SQL transaction。它们没有证明 provider 网络可达、resolver 返回真实 route、failure 已经做 secret redaction、进程中断一定执行 finalizer，或 S01-T08 已经把每次模型调用接到 audit；这些属于 Gateway、process supervision 与后续安全测试。

## 亲手验证

从 Core package 运行 focused audit 与 Store 回归：

```bash
cd packages/core
bun test test/adaptive/model-audit.test.ts test/adaptive/store.test.ts
bun test test/database-migration.test.ts
bun typecheck
bun script/migration.ts --check
```

预期观察：所有 test 退出码为 `0`，focused audit 文件包含 13 个通过用例且没有 failure；migration test 同时覆盖 fresh schema 与已存在 T03 row 的升级，typecheck 和 migration check 同样退出 `0`。若 admission case 失败，先检查 TestClock 下 lease 是否仍有效；若 valid proof 多出 reason，直接按 reason 中的 Request ID 分别查询 immutable policy columns 和 `resolved_*` observation columns。`CORRUPT_*_POLICY` 表示 fields 与 hash 不再 canonical 自洽，`REQUEST_POLICY_MISMATCH` 表示 row 本身自洽但不再等于 Task policy。

再从 repository script package 验证教程结构：

```bash
cd script
bun test adaptive-tutorial-check.test.ts
```

预期观察：模板章节、索引链接、中文正文和残留 marker 检查全部通过。这里的 13 个 focused case 是当前本地运行事实，不是历史 PR 的统计数字。

## 当前边界与下一步

本任务只负责 durable admission、状态与 validity proof，不负责构造 `LLM.request`、连接 provider、累计 stream event、自动 retry 或将 Task 标为 `invalid`。`verify` 会把 corrupt policy 变成稳定 invalid reason，但 `AdaptiveStore.getModelRequest` 仍沿用 T03 的 `CorruptModelPolicyError` taxonomy；本任务不扩张该错误分类。`SettlementInput.failure` 是已经由上游收敛的摘要；本层不接收 header、credential 或 prompt body，也不承担通用 secret scanner。

S01-T08 会让 Model Gateway 严格执行 `admit → resolve → streaming → one provider stream → terminal settle`，并在不可中断 finalizer 中覆盖 `succeeded|failed|interrupted`。后续 benchmark completion 再消费 `verify`。如果调用方绕过 audit service、Gateway 没有 settlement，或只通过 generic Store terminal settlement 而没有 resolved observation，verifier 会分别以零请求、`UNSETTLED_MODEL_REQUEST` 或 `MISSING_RESOLVED_MODEL_OBSERVATION` fail closed，结果不能进入有效 benchmark 比较。
