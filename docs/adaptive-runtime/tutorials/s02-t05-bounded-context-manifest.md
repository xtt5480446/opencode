# S02-T05：有预算的 ContextManifest 重建

## 先说结论

本任务让每一次 Adaptive Agent 的模型调用，都先从 durable 状态重新组装一份不可变的 `ContextManifest`，而不是延续上一进程的无限对话历史。Worker 完整保留 Requirement、全局 Roadmap、当前 Assignment 和精确版本的直接 contract；Coordinator 则保留完整 Roadmap 和一个由持久化 event cursor 派生的 cycle input。其余 Detail、workspace、失败验证、RepoMap、事件尾部和本地 tail 依据固定预算与固定顺序选择，并把未选中的内容和原因一并持久化。

当全局骨架放不进模型输入预算时，系统返回 `ContextBudgetUnsatisfiable`，不会留下半份 Manifest。当只是当前节点及其契约过大时，系统追加 durable `ContextSplitRequired` 事件，要求后续 Coordinator 拆分节点，而不是调用摘要模型硬塞进 context。它还会在 context 接近预算、tail 过长或 checkpoint 之后事件过多时标记软重启；真正的 checkpoint、停止与 replacement generation 由 S02-T07/T08 执行。

## 它在当前 Milestone 中的位置

S02-T01 到 T03 已经把可恢复的开发事实放进 SQLite，并能从 durable event 重建 projection；S02-T04 能把这些事实稳定渲染成文本。本任务把两者变成一次可审计、可重复的模型输入，因此 Agent 进程丢失上下文后仍有明确的重建来源。

```text
S02-T02 durable state + S02-T03 replayable projection + S02-T04 stable rendering
  → S02-T05 bounded ContextManifest assembly
  → S02-T06 real workspace/tool facts
  → S02-T07 turn loop + S02-T08 forced replacement recovery
```

这正是短上下文策略的关键约束：完整 Roadmap 作为全局导航始终存在，Worker 只取当前工作和按需 Detail，不以扩大模型序列长度或重放完整 transcript 作为恢复手段。

## OpenCode baseline 与复用边界

OpenCode baseline 的普通 `Session` 路径会沿用 Session message history，并在需要时使用 compaction。Adaptive Runtime 不把这份历史当作权威状态；它在 provider admission 前只读取自己的 `AdaptiveTask`、Roadmap、Assignment、Checkpoint 与 task aggregate event。

本任务复用 Core 的 `AdaptiveStore` immutable Manifest 表、`AdaptiveRoadmapStore` 精确版本 Detail 查询、`AdaptiveRecoveryStore` Checkpoint 查询、`EventV2.readAggregate` 以及 `Token.estimate`。模型调用仍复用已有 `AdaptiveModelGateway`，但 Gateway 只接受已持久化 Manifest，并为相同 Task/Roadmap revision 设置 provider 的 `promptCacheKey`；缓存命中不是正确性前提。

没有复用 Session compaction、摘要历史或“读取当前 Detail 的最新版”语义。Detail 必须通过 `key@version` 精确读取，防止重启后把 Worker 曾依赖的接口版本悄悄替换掉。

## 最终实现

`packages/opencode/src/adaptive/context/assembler.ts` 分成纯函数 `plan()` 与生产服务 `assemble()`。

- `plan()` 接收结构化快照，负责 canonical JSON、token 预算、稳定排序、选择、淘汰、request hash 和 restart signal；它是单元测试预算边界的纯函数。
- `assemble()` 不接受调用方伪造的 Roadmap、Assignment、Detail、Checkpoint 或 event snapshot。它按 ID 从 SQLite Store 读取当前 Roadmap、Agent role/cursor、immutable Assignment、精确 Detail 版本、最新 Checkpoint 以及 cursor 之后的 durable events，再调用 `plan()`。没有 Checkpoint 的首次 Worker turn 也会从 Agent cursor 之后开始，不会重放任务创建以来的历史。
- `AdaptiveContextRequest.prepare()` 是 Assembler 和 Gateway 共用的逻辑请求封套：它固定 model policy identity、`SystemPart`、messages、tools、prompt cache key 和 `maxTokens`，以同一份 canonical JSON 计算 `estimatedTokens` 与 request hash。Gateway 在调用 provider 前会重新计算并拒绝不一致的 Manifest。
- 成功时 `AdaptiveStore.putManifest()` 在 `immediate` transaction 中写入完整 Manifest；同时以读取时的 Roadmap revision、Assignment、Checkpoint、Agent cursor 和 aggregate event sequence 做 optimistic compare。事实变化则回滚本次插入并重组一次。若有 restart reason，同一 transaction 还会把该 Agent generation 标记为 `restart_required=true`。`ContextSplitRequired` 也在自身 durable event transaction 内重复相同 source compare 与 owner/generation/lease 检查，因此旧进程不能在 replacement 之后留下错误的拆分升级。失败时不会写 Manifest。

Worker 的不可驱逐 prefix 顺序固定为：role instructions、Requirement Baseline、完整 Roadmap、Assignment、Assignment 引用的 contract。Assignment 可以引用当前节点的 contract，也可以引用 Roadmap 明确声明的直接依赖节点 contract；后者必须同时满足精确 version、所属节点 Roadmap 索引和 `contractKey` 依赖关系，不能借此任意读取别的节点 Detail。

Assignment 本身是 immutable work order，因此 replacement generation 可以继续读取较早 generation 创建的 Assignment 和最新 Checkpoint；校验要求它们的 generation 不得晚于当前 Agent generation，而不是必须相等。Task、Worker ID、Assignment ID、Roadmap revision 和 checkpoint node 仍然必须精确匹配，避免新 Worker 借用别的节点或未来进程的恢复状态。

可驱逐内容按保留优先级加入，预算不足时不截断文本，而是记录 omission。反向看其淘汰顺序是：成功验证输出、旧 local tail、RepoMap、Worker 按需打开的 Detail、strong context。失败验证保持 strong priority，不会被一次成功命令的冗长输出挤掉。Checkpoint cursor（或尚无 Checkpoint 时的 Agent cursor）之后的 event 按 sequence/id 去重排序，最多放入 256 条；超过时仍留下 restart signal，避免以无限 tail 继续运行。Coordinator 默认排除 implementation workspace/diff，只有其 event 明确承载的事实才进入 cycle。

```text
turn invocation
  → read Task / Agent role+cursor / Roadmap / Assignment / exact Details / Checkpoint / events from Stores
  → render Worker Assignment contracts or a Coordinator cycle input
  → reserve output + safety budget against the shared request envelope
  → compare durable source versions, persist immutable ContextManifest (and restart flag when required)
  → AdaptiveModelGateway reads only that Manifest and streams the pinned model
```

## 推荐代码阅读路线

1. `packages/opencode/src/adaptive/context/assembler.ts` 的 `plan()`：先看 input budget、mandatory prefix、候选部件和 omission 如何形成一份完整 request。
2. 同文件的 `assemble()`：看生产路径怎样从 Store 获取权威事实、使用 Agent cursor，以及何时因 source 变化重组。
3. `packages/opencode/src/adaptive/context/request.ts` 的 `prepare()`：看 Assembler 和 Gateway 怎样共享同一份 request hash/token 口径。
4. `packages/core/src/adaptive/store.ts` 的 `putManifest()`：看 Manifest immutable insert、source compare 与 `restart_required` 如何在同一 transaction 完成。
5. `packages/opencode/src/adaptive/model-gateway.ts` 的 `stream()`：看 Gateway 如何重算 Manifest request evidence 后才调用 provider。
6. `packages/opencode/test/adaptive/context-assembler.test.ts`：从紧预算、版本变化、跨节点 contract、cursor event、Coordinator cycle 与 restart 边界反向理解不变量。

## 术语释义

- **ContextManifest**：直觉上是“这一回合到底给模型看了什么”的不可变收据。工程上是一行持久化的 system、messages、tools、component provenance、omission、token estimate 和 request hash。本项目中它让重启、审计和模型调用使用同一份输入事实。
- **input budget**：模型可接收总长度减去固定 `outputReserve` 和 `safetyReserve` 后，实际允许输入的 token 上限。它不是“差不多够用”的估计；每次选择一个 component 后都会重新估算完整 request 序列化。
- **mandatory component**：不允许因为节省 token 被省略的上下文。这里包括全局导航和当前节点必须遵守的工作单/接口契约；放不下时代表任务切分或依赖边界有问题。
- **direct dependency contract**：当前 Roadmap node 明确依赖的另一节点对外接口。它通过 dependency 的 target node 与 `contractKey` 连接到精确 Detail version，使跨模块协作传递接口而非整段开发历史。
- **soft restart**：达到 80% input budget、24 个 local turns 或 256 条 checkpoint 后 event 时设置的后续重建信号。当前回合可以结束；S02-T08 会负责保存 checkpoint 并启动全新 generation。
- **optimistic compare**：直觉上是“先读、后写，但写入前确认没有人改过”。工程上是 Manifest insert transaction 比对读取时保存的 Roadmap、Assignment、Checkpoint、cursor 和 event sequence；不一致就不写入。本项目中它阻止新旧事实被混进同一份 prompt。

## 测试看护逻辑

| 风险 | 测试方法 | 关键断言 | 证明范围 |
| --- | --- | --- | --- |
| 进程重启时 Roadmap 或 contract 不是同一份事实 | `persists one exact Manifest with the global graph and direct contract` | SQLite 读取的 Manifest 包含全局骨架、Assignment 和精确 contract；同状态重组 byte-equal | 权威存储加载与 deterministic Manifest |
| token 紧张时丢掉失败证据或淘汰顺序漂移 | `evicts successful output, old tail, RepoMap, requested Detail, then strong context` | success 先于 tail/RepoMap/按需 Detail 被记录为 omission，failed validation 仍存在 | 优先级和 omission 可审计 |
| 全局过大与单节点过大走同一种不安全错误 | `rejects a global overflow and emits ContextSplitRequired for current-node overflow` | 前者无 Manifest；后者无 Manifest 且 task aggregate 多一条 split event | 预算失败分类与 durable escalatation |
| 恢复时取错 diff 或接口版本 | `changes the request hash when workspace or exact Detail version changes` | source revision 与 request hash 同时改变 | 变更不会被 prompt cache 或 hash 掩盖 |
| Manifest 的 token/hash 与 Gateway 发给 provider 的请求脱节 | `rejects a Manifest whose budget evidence does not match the exact provider request envelope` | 篡改 estimate/hash 后 Gateway 不调用 provider | 预算与审计基于同一个逻辑请求封套 |
| 模块接口必须重载整段依赖模块历史 | `keeps an Assignment dependency contract from its owning Roadmap node` | Roadmap 直接依赖的跨节点 contract 以 mandatory component 注入 | 精确接口可以跨节点传递，任意 Detail 不可越权引入 |
| 首次恢复仍重放 task 创建以来的事件 | `reads only durable events after the Agent cursor before its first Checkpoint` | 260 条 cursor 前事件不进入 Manifest，只有之后的 3 条进入 | Worker 与 Coordinator 都有持久化 event 起点 |
| Coordinator 被 implementation diff 污染 | `derives the Coordinator cycle from the authoritative Agent cursor` | authoritative role 派生 mandatory cycle，调用方传入的 workspace 不出现 | Coordinator 的全局重建不依赖 Worker 局部磁盘上下文 |
| Coordinator cycle 自己超过 budget 却进入 provider | `fails closed when a mandatory Coordinator cycle exceeds the input budget` | 返回 `ContextBudgetUnsatisfiable`，不生成 Manifest | Coordinator 的 mandatory context 同样受硬预算约束 |
| 读取到写入之间发生 Roadmap 或 cursor 变化 | `rejects a Manifest when its durable source state changed before persistence` | Store 返回 `ManifestSourceChanged` 且不写入 Manifest | 变化的 durable state 不会与旧 ContextManifest 混装 |
| 过期或已变化的 Worker 仍上报 context split | `rolls back ContextSplitRequired when its durable source changes during publish` 与 `does not publish ContextSplitRequired after the Agent lease expires` | event transaction 回滚，task aggregate count 不变 | split escalation 与普通 Manifest 具有相同的 source/ownership 边界 |
| checkpoint 前事件重复进入 replacement context | `selects only unique events after the Checkpoint cursor in sequence order` | 只保留 cursor 后、按 sequence 稳定排列的唯一 event | durable tail 重建边界 |
| event ID 位数变化导致 10 排在 9 前 | `keeps event chronology numeric across decimal key boundaries` | `event:9` 始终先于 `event:10` | event tail 在恢复 prompt 中保持真实因果顺序 |
| replacement generation 无法继承已提交的工作状态 | `rebuilds a replacement generation from its immutable Assignment and prior Checkpoint` | gen2 Manifest 使用 gen1 Assignment/Checkpoint，仍记录 gen2 自己的 Manifest generation | 进程替换不会要求重写工作单或丢弃最近 checkpoint |
| context 长度悄悄变为无限历史 | `signals a soft restart at the token, local-turn, and event-tail boundaries` | 三种阈值分别产生 restart reason，event 只注入 256 条 | 重启触发条件与 event tail 上限 |

这些测试不证明真实 Git inspection、工具 side effect 的 exactly-once、provider 兼容性或真实进程死亡后的 replacement 成功。这些将分别由 S02-T06、S02-T07、S02-T08 和 G2 的 S02-T09 coding fixture 覆盖。

## 亲手验证

在仓库中运行：

```bash
cd packages/opencode
bun test test/adaptive/context-assembler.test.ts test/adaptive/context-render.test.ts test/adaptive/model-gateway.test.ts
bun typecheck

cd ../core
bun test test/adaptive/store.test.ts
bun run typecheck

cd ../..
cd script
bun test adaptive-tutorial-check.test.ts
```

预期观察：聚焦测试全部通过、0 failures，typecheck 退出码为 0，教程 validator test 全部通过。CI 会在真实 PR event 中额外检查 S02-T05 声明、目标分支和 README 索引匹配。预算测试失败时先检查 Requirement/Roadmap/Assignment 是否被错误省略，或完整 `{ system, messages, tools }` 估算是否绕过；不要通过截断 Detail 或调用摘要模型让测试变绿。

## 当前边界与下一步

本任务还不执行真实 workspace inspection，也不把 Manifest 接入 Agent 的 read/edit/bash 工具回合；这些由 S02-T06 和 S02-T07 完成。它同样只设置 restart flag，不自行 checkpoint、拒绝下一普通 turn、替换子进程或推进 Coordinator cursor；S02-T08 负责这些恢复流程。

因此，S02-T05 证明的是“给定 durable 事实，系统能稳定、受预算地重建这一回合模型输入”。G2 尚未证明模型能在真实仓库完成 coding，更未证明 Worker/Coordinator 被强杀后仍完成；只有 S02-T09 的真实单 Worker fixture 会成为面向你的系统验收点。
