# S01-T03：Foundation Database 与 Transactional Store

## 先说结论

S01-T03 第一次把 Adaptive Runtime 从“进程内契约”变成了可重启的权威状态。Task、Agent process ownership、ContextManifest 和 model request audit 不再只存在于当前 Agent 的 transcript 或内存对象中，而是进入 OpenCode 已有 SQLite 数据库，并由 `AdaptiveStore` 提供窄而明确的读写接口。

这一步直接服务于短上下文 Agent：Worker 或 Coordinator 可以周期性清空上下文，甚至由新进程接管，然后通过稳定 ID 从数据库恢复 Task 的原始需求与冻结 ModelPolicy、Agent 当前 generation、构造模型输入所使用的 Manifest，以及已经发生过的 Request。恢复过程不需要重放此前全部对话。

本任务没有实现 Roadmap、Detail Pool、context assembly、模型解析或 provider call。它交付的是这些上层能力可以信任的持久化底座和并发所有权规则。

## 它在当前 Milestone 中的位置

S01-T03 位于 G1 Execution Foundation 的中间：前两项任务已经定义身份和 ModelPolicy 完整性，后续任务才开始解析模型、准入请求和启动独立 Agent 进程。

```text
S01-T01 AdaptiveTask public contract
  → S01-T02 deterministic ModelPolicy identity
  → S01-T03 durable Task / Agent / Manifest / Request state
  → S01-T04 exact model reference resolution
  → S01-T05 audited model-request admission
  → S01-T06 supervised Agent process protocol
```

如果没有 S01-T03，后续的 Coordinator 和 Worker 只能把“我属于哪个 Task、我持有哪一代 ownership、刚才使用了哪份 context、请求是否已经完成”放在进程内变量里。上下文清空或进程退出后，这些事实就会丢失，所谓可重启 Agent 只剩下重新猜测历史。

这一层选择保存结构化状态而不是长 transcript。完整 Roadmap 和 Detail 以后会成为更多可按 key 读取的结构化记录；S01-T03 先证明同一模式可以在 Task、Agent、Manifest 和 Request 上成立。

## OpenCode baseline 与复用边界

OpenCode 已经拥有成熟的 SQLite 基础设施，S01-T03 没有再造数据库连接、migration runner 或 ORM。

真实 baseline 调用链是：

```text
Database.layerFromPath(filename)
  → Effect SQLite driver
  → EffectDrizzleSqlite database
  → SQLite PRAGMA configuration
  → DatabaseMigration.apply()
  → domain service receives Database.Service
```

本任务直接复用了以下模块：

| Baseline 能力              | 位置                                       | S01-T03 的复用方式                                                       |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `Database.Service`         | `packages/core/src/database/database.ts`   | 获取已经配置好的 Effect/Drizzle database                                 |
| `Database.layerFromPath()` | 同上                                       | 构建真实文件数据库并验证新进程恢复                                       |
| `DatabaseMigration`        | `packages/core/src/database/migration.ts`  | 事务化应用生成 migration，并维护 migration journal                       |
| migration generator        | `packages/core/script/migration.ts`        | 从 Drizzle declaration 生成 migration、registry、完整 schema 和 snapshot |
| `Timestamps`               | `packages/core/src/database/schema.sql.ts` | 沿用 Core 的时间列约定                                                   |
| `makeGlobalNode()`         | `packages/core/src/effect/app-node.ts`     | 把 `AdaptiveStore` 接入现有 Effect service graph                         |
| Drizzle `returning()`      | baseline 多个 Store/Projector              | 用返回行判断条件写是否真正成功                                           |
| `Schema.TaggedErrorClass`  | Core domain services                       | 暴露可分类、可序列化的预期失败                                           |

“复用同一个数据库”不等于复用 Session 业务语义。OpenCode 的 Session store 面向消息、事件投影和交互会话；Adaptive Task 需要冻结 ModelPolicy、独立 process generation、lease ownership、ContextManifest 和 request audit。把这些字段塞入 Session metadata 会让两个生命周期互相绑死，也无法表达一个 Task 下多个可重启 Agent。

因此最终实现复用的是 database infrastructure 和工程范式，而不是 Session 的聚合模型。四张 `adaptive_*` 表与 baseline Session/Event 表平行存在，默认 OpenCode 路径没有被改写。

## 最终实现

实现由三层组成：Drizzle schema 描述持久化不变量，生成 migration 负责部署，`AdaptiveStore` 负责业务级 transaction、CAS 和 typed error。

```text
Typed input
  → in-memory validation
  → transaction / conditional UPDATE
  → SQLite constraints and foreign keys
  → immutable record or typed conflict
```

### 四张权威表

`adaptive_task` 保存 Task ID、原始 requirement、directory、mode/status、完整 ModelPolicy、Roadmap revision、base snapshot hash 和时间。Store 没有 ModelPolicy update API；每次读取都会重新计算 policy hash。如果数据库里字段或 hash 被外部篡改，返回 `AdaptiveStore.CorruptModelPolicy`，不会用损坏策略继续执行。

`adaptive_agent_process` 保存 Agent role、generation、lifecycle state、owner、PID、lease 和 exit result。未被占用的 Agent 从 generation `0`、state `idle` 开始。只有 `starting|running` 可以带 owner/PID/lease；`idle|stopped|lost|failed` 必须全部为空。SQLite `CHECK` 约束会拒绝“有 owner 但没有 PID”这类半状态。

`adaptive_context_manifest` 保存一次模型输入的不可变结构：有序 system strings、messages、tools、components、估算 token、request hash，以及对应的 Task/Agent/generation。Manifest 不提供 update API，因为审计需要知道某次 Request 究竟看到了哪份输入，而不是读取一份后来被覆盖的记录。

`adaptive_model_request` 保存 Request 与 Manifest 的引用、retry lineage、完整 ModelPolicy snapshot、status、token 和 failure。创建状态只能是 `admitted`；settlement 只能把 `admitted|streaming` 一次性推进到 `succeeded|failed|interrupted`。

### Task 完整性读取

`createTask()` 使用 caller-supplied ID 和 Effect `Clock` 写入一行。重复 ID 通过：

```text
INSERT ... ON CONFLICT DO NOTHING RETURNING
```

返回空行时映射为 `AdaptiveStore.DuplicateTask`，不会解析脆弱的 SQLite 错误文本，也不会覆盖原 Task。

`getTask()` 从数据库重建 `AdaptiveTask.ModelPolicy`，再调用：

```ts
AdaptiveModelPolicy.assertEqual(modelPolicy, modelPolicy)
```

这里看似自己比较自己，实际会重新计算对象字段对应的 SHA-256，并确认 stored hash 一致。S01-T02 已证明两个相同伪造对象也无法通过这个检查。

### Agent generation 与 lease CAS

`claimAgent()` 不是“先读取、再决定、再写入”。它执行一条条件 update：

```text
match agentID
AND generation == expectedGeneration
AND (owner is empty OR lease expired)
  → generation = generation + 1
  → state = starting
  → set owner / PID / new lease
  → clear old exit result
  → RETURNING updated row
```

两个 Controller 同时使用 expected generation `0` claim 时，SQLite 只能让一个 update 命中；另一个看到空 `RETURNING`，随后只读当前行以分类 `AgentNotFound` 或 `AgentClaimConflict`。这个分类读取不会再触发写操作，所以不引入第二个竞态窗口。

`heartbeat()` 还要求 generation、owner、active state 全部匹配，并且 lease 在当前 Effect Clock 时间之后。成功后把 `starting` 推进为 `running` 并延长 lease。到期时刻按 expired 处理，避免边界上两个 owner 都认为自己有效。

`settleAgent()` 不要求 lease 尚未到期。旧进程退出较慢时，仍可在无人接管的情况下补记 `stopped|lost|failed`；但它必须继续匹配 generation 和 owner。一旦另一个 Controller 已 claim 下一代，旧 generation settlement 原子失败，不能覆盖新 owner。

### Manifest transaction 与 JSON 边界

`putManifest()` 在接触 SQLite 前递归校验 JSON。允许 `null`、boolean、finite number、string、array 和 plain object；拒绝 `undefined`、BigInt、function、symbol、`NaN`、Infinity、class instance 和循环引用。这样损坏输入会在创建 Manifest 时得到 `InvalidManifest`，而不是在重启恢复或 provider serialization 时才爆炸。

随后一个 transaction 同时完成：

1. 验证 `taskID + agentID + generation + owner` 对应 active、未过期 lease；
2. 写入不可变 Manifest；
3. 使用 `RETURNING` 区分 duplicate。

owner 不作为 Manifest 内容保存。它只是写入授权条件；审计内容保存 generation，因为 generation 才是跨重启稳定的 ownership 版本。

### Request 引用与一次性 settlement

`insertModelRequest()` 在同一个 transaction 中读取 Manifest，并要求 Task、Agent、generation tuple 完全相同。`retryOf` 存在时，parent Request 必须存在且属于同一个 Task。验证失败时 transaction 不会留下半条 Request。

Request 保存完整 ModelPolicy 字段加 hash，而不只保存 `modelID`。这样未来 benchmark audit 能独立重算每次请求使用的 provider、variant 和 context budget。

`settleModelRequest()` 用条件 update 限制一次性终结：

```text
UPDATE adaptive_model_request
SET terminal fields
WHERE id = requestID
  AND status IN ('admitted', 'streaming')
RETURNING ...
```

第二次 settlement 得到 `RequestAlreadySettled`，未知 ID 得到 `RequestNotFound`。负 token 或非整数 token 在写入前得到 `InvalidRequest`，原 Request 保持 `admitted`。

### 真正的 restart 路径

file-backed restart test 没有复用同一个 Store instance。它先用 `Database.layerFromPath(filename)` 构建第一套 Effect graph，写入完整状态并销毁 scope；随后用同一文件构建全新的 Database 与 `AdaptiveStore` layer，再读取四种记录。

```text
Process layer A writes SQLite file
  → layer A scope closes
  → process-local services disappear
  → layer B opens the same file
  → Task / generation / Manifest / Request match exactly
```

这证明恢复不依赖 module cache、闭包或 Agent transcript。它还没有证明 Coordinator 已经会自动拼装重启后的 system prompt；那是后续 context recovery 任务的消费者逻辑。

## 推荐代码阅读路线

1. 先读 [`sql.ts`](../../../packages/core/src/adaptive/sql.ts) 的四张表和 `CHECK`/foreign key，理解数据库拒绝哪些非法状态。
2. 再读 [`store.ts`](../../../packages/core/src/adaptive/store.ts) 顶部的 input、record 和 typed error，先建立 API 视图。
3. 阅读 `taskRecord()` 与 `requestRecord()`，观察普通 SQLite string 如何恢复为 canonical ID 和 ModelPolicy，并重新做 integrity check。
4. 顺序阅读 `claimAgent()`、`heartbeat()`、`settleAgent()`，重点看 `.where(...)` 条件和 `.returning()`，不要只看错误分类 helper。
5. 阅读 `jsonValue()`、`putManifest()` 和 `insertModelRequest()`，理解内存验证与 transaction 各自负责什么。
6. 最后读 [`store.test.ts`](../../../packages/core/test/adaptive/store.test.ts)，尤其是 concurrent claim 和 file-backed restart 两条测试。
7. 需要了解部署时，再看生成的 [`20260717090000_adaptive_runtime_foundation.ts`](../../../packages/core/src/database/migration/20260717090000_adaptive_runtime_foundation.ts) 和 migration test。

## 术语释义

### Authoritative state

直觉上，它是“系统重新启动后仍然承认的事实”。工程上，权威状态必须有唯一写入规则、可验证约束和持久存储。本任务中 SQLite 记录是 Task、generation、Manifest 和 Request status 的权威来源；内存对象只是当前读取结果。

### Transaction

Transaction 把多次数据库操作组成一个原子单元：要么全部提交，要么全部回滚。Manifest ownership 验证和 insert 必须在同一 transaction，否则 owner 可能在两步之间变化，或者验证失败后留下半行。

### Compare-and-swap（CAS）

CAS 的直觉是“只有当前值仍是我刚才预期的值，才允许替换”。这里不是 CPU 指令，而是 SQL 条件 update：generation、owner 和 lease 条件全部命中才写入。`RETURNING` 是否有行就是 CAS 成功与否的证据。

### Generation

Generation 是一个 Agent ownership 的单调版本号。进程重启可以继续使用同一个 AgentID，但每次成功 claim 都增加 generation。旧进程即使晚到，也无法用旧 generation 修改新进程状态。

### Lease

Lease 是有期限的 ownership。heartbeat 延长期限；过期后其他 Controller 可以接管。它不同于永久 lock，适合可能崩溃或断联的独立 Agent 进程。

### Immutable record

Immutable record 创建后不提供 update API。Manifest 和 Request 的 policy snapshot 采用这个策略，使审计结果指向确切历史输入。Request status 是少数可变字段，但只能执行受限的一次性状态迁移。

### Typed error 与 defect

Typed error 是调用者预期处理的业务失败，例如 duplicate、not found、ownership conflict；Effect 类型会明确列出它。SQLite 驱动损坏、磁盘 I/O 异常等未知故障仍是 defect，不会被伪装成 `DuplicateTask`，否则上层可能错误重试并隐藏真实事故。

### Foreign key

Foreign key 要求引用目标真实存在。Manifest 不能指向不存在的 Agent，Request 不能指向不存在的 Manifest，retry 不能悬空。它是数据库层最后一道关系完整性保护，不代替 Store 的业务 tuple 验证。

## 测试看护逻辑

| 风险                           | 测试方法                       | 关键断言                                    | 证明范围                    |
| ------------------------------ | ------------------------------ | ------------------------------------------- | --------------------------- |
| Task 重启后字段丢失            | Task create/get round trip     | 完整 record 与时间相同                      | Task foundation 可持久读取  |
| duplicate 覆盖原需求           | duplicate Task/Agent tests     | typed duplicate 且原记录不变                | retry 不会变成覆盖写        |
| DB 中 policy 被篡改            | raw hash mutation test         | `CorruptModelPolicy`                        | 读取不盲信 stored hash      |
| 两个 Controller 同时持有 Agent | concurrent claim               | 一个 success、一个 failure、generation 为 1 | claim 是原子 CAS            |
| 旧 owner 覆盖新一代            | expired reclaim + stale settle | stale settlement 返回 ownership conflict    | generation 隔离成立         |
| lease 到期边界不一致           | heartbeat at exact expiry      | heartbeat 被拒绝                            | 到期比较语义明确            |
| 非 JSON context 污染数据库     | unsupported Manifest input     | `InvalidManifest` 且无记录                  | 写入前 JSON 边界有效        |
| 错 owner 写 Manifest           | ownership mismatch             | transaction 回滚且 Manifest not found       | 授权验证与 insert 原子      |
| Request 指向错误 generation    | tuple mismatch                 | `RequestReferenceMismatch` 且无记录         | Request/Manifest 关联可信   |
| Request 被重复终结             | second settlement              | `RequestAlreadySettled`                     | terminal transition 一次性  |
| 非法 token 部分更新状态        | negative token settlement      | `InvalidRequest` 且 status 仍 admitted      | validation 在 mutation 之前 |
| Store 偷用进程内 cache         | file-backed layer rebuild      | 新 layer 读回四类记录完全相等               | SQLite 足以支持进程重建     |
| migration 破坏 baseline        | complete migration suite       | V1 Session/Event 状态与迁移断言通过         | 新表与既有 schema 共存      |

这些测试没有证明：多机 SQLite 共享、网络文件系统 lease、Coordinator 自动恢复流程、Roadmap/Detail 的一致性、真实 provider call、tokenizer 估算准确性或 benchmark 同模型报告。它们属于后续 Task。

## 亲手验证

在仓库根目录运行 Store 与 ModelPolicy 测试：

```bash
cd packages/core
bun test ./test/adaptive
```

当前任务分支预期：

```text
21 pass
0 fail
```

其中 `AdaptiveStore recovers ... from a new process layer` 会创建真实临时 SQLite 文件、销毁第一套 layer、构建第二套 layer 并比较恢复结果。

验证 migration 与旧状态兼容：

```bash
bun test ./test/database-migration.test.ts
bun script/migration.ts --check
```

当前预期是 migration test `16 pass / 0 fail`，并看到：

```text
No schema changes, nothing to migrate
```

最后执行：

```bash
bun run typecheck
```

若 migration check 报 drift，先检查 `packages/core/src/adaptive/sql.ts` 是否变化，再运行正式 generator；不要手改 `schema.json`、`schema.gen.ts` 或 migration registry。若 restart test 失败，优先查看临时文件路径、foreign key、generation 和 ModelPolicy hash，而不是增加 sleep。

历史 PR 的运行数字应与当前运行分开理解：上面的数字是本任务分支完成时的 focused 证据；未来 OpenCode 增加测试后，验收标准仍是所有匹配测试零失败。

## 当前边界与下一步

S01-T03 已经建立：

```text
stable IDs
  → durable records
  → atomic ownership
  → immutable context/request evidence
  → process-independent recovery
```

但它故意没有实现以下能力：

- S01-T04 才把 ModelPolicy 解析为一个真实可用的 provider/model reference。
- S01-T05 才在 provider call 前验证 Task policy、lease、Manifest 和 retry eligibility，并记录 admission。
- S01-T06 才启动独立 Agent 进程并通过受限 RPC 传播 Task/Agent/Manifest ID。
- S02 阶段才加入 Roadmap、Detail、Assignment、Checkpoint、context budget 和恢复 prompt assembly。

因此，“数据库可以恢复 Manifest”不等于“Agent 已经自动恢复上下文”。本任务保证后续恢复逻辑有可信、可定位的事实来源；如果这一层失败，Coordinator 重启、Worker replacement 和 benchmark audit 都不能继续声称全局一致。

设计背景见 [S01-T03 design spec](../../superpowers/specs/2026-07-18-s01-t03-adaptive-store-design.md)，最终行为以本教程链接的代码、migration 和测试为准。
