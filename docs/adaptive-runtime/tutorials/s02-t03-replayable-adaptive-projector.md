# S02-T03：可重放的 Adaptive Projector

## 先说结论

本任务让 Adaptive Runtime 可以删除一项 Task 的派生恢复状态，再只依靠该 Task 已经存在的 durable Adaptive events，按原始 `seq` 顺序确定性重建 Roadmap revisions、Details、Assignments、Checkpoints，以及 Agent 当前的 node、Assignment、checkpoint sequence 和 event cursor 指针。重建不删除、不改写，也不重新发布 `EventTable` 中的权威事件；它不读取 Session transcript，更不调用模型做摘要。

这不是“从零恢复整个 Adaptive Task”。当前事件契约没有携带 `base_snapshot_hash`、完整 Agent process/lease 状态等事实，因此 `AdaptiveProjector.rebuild()` 明确保留 `adaptive_task` 和 `adaptive_agent_process` 根行，只重置并重建事件能够证明的派生边界。缺失的事实不会用默认值或猜测补齐。

## 它在当前 Milestone 中的位置

S02-T01 定义了完整的 durable event payload，S02-T02 提供了规范化的不可变存储，本任务证明两者真的形成可恢复的 event-derived state。后续 Context Assembler 和 replacement Worker 可以读取重建后的 Roadmap、Assignment 与 Checkpoint，而不依赖旧进程的内存或聊天历史。

```text
S02-T01 recovery contracts + S02-T02 normalized stores
  → S02-T03 deterministic projection and rebuild
  → S02-T04 context rendering / later replacement recovery
```

对短上下文 Agent 而言，关键价值不是保存更多自然语言，而是把 restart 所需事实变成可以校验、可以重放、可以精确引用的结构化状态。如果本任务不成立，后续恢复流程即使能重新启动进程，也无法证明新进程看到的 Roadmap revision 和 Checkpoint 与崩溃前一致。

## OpenCode baseline 与复用边界

修改前，`EventV2.publish()` 已经提供 durable aggregate sequence、单事务 projector、local `commit(seq)` callback，以及外部事件 replay。最终实现又为 projector registration 加入稳定 identity 与逐 projector replay policy。一次 S02-T02 写入走的是：

```text
AdaptiveRoadmapStore / AdaptiveRecoveryStore
  → EventV2.publish(definition, payload, { commit })
  → transaction: projectors first → commit callback → EventSequenceTable/EventTable
```

本任务直接复用以下能力：

- `EventV2.Service.project()`：让正常的 live durable event 在写入事件的同一个事务内更新派生状态。
- `EventV2.readAggregate()` 与 `AdaptiveDurable` manifest：从 `EventTable` 解码已有 Adaptive aggregate，并保持 `seq` 顺序。
- `Database` transaction：让“清空派生边界 + 全量重放”要么整体成功，要么整体回滚。
- S02-T02 的表和 store API：Projector 写回同一套 `adaptive_roadmap_revision`、`adaptive_detail`、`adaptive_assignment`、`adaptive_checkpoint` 与 Agent 指针，没有建立第二套恢复数据库。

`EventV2.replay()` 只借鉴 envelope 解码和顺序语义，不能直接承担 rebuild：generic sync 必须能够在没有 `adaptive_task` / `adaptive_agent_process` roots 的目标 Workspace 中先持久导入 Adaptive rows，不能根据 payload 发明缺失的根事实。因此 Adaptive projector registration 明确设置 `replay: false`，而原有未设置 policy 的 Session projectors 继续参与 replay。Adaptive rebuild 则显式读取本地已有 aggregate 并调用相同的确定性 projection handlers。

Session projector 只提供了“durable event 可同步派生查询表”的工程范式。本任务没有复用 Session transcript、message projection 或 compaction 语义，因为它们不是 Adaptive recovery state 的权威来源。

## 最终实现

`AdaptiveProjector.Service` 暴露三个清晰入口：

- `ready`：只有所有 Adaptive live projectors 注册完成后，service 才能被构造。`AdaptiveController.make()` 解析该 service，`start()` 把等待 `ready` 作为第一步，因此输入校验和 Task admission 都不能越过 projector registration。
- `reproject(event)`：对一个已解码的 durable Adaptive event 重新执行 projection，不写 Event row。一次 reproject 使用 immediate transaction；exact normalized state 通常是 no-op，但如果对应 Assignment / Checkpoint row 完整而 Agent 派生指针被清空，且该 event 不旧于当前 cursor，它会修复指针。较旧 event 永不回退更新的 cursor 或 checkpoint pointer；divergent normalized row 返回 `ProjectionConflictError`。
- `rebuild(taskID)`：分页读取既有 aggregate，在一个 immediate transaction 中清理 owned projection boundary、重置 Task/Agent 派生指针，再逐事件调用 `apply(..., "rebuild")`。

生产 runtime 直接把 `AdaptiveProjector.node` 放入 `AppLayer`，同时 `AdaptiveController.node` 也声明它为依赖。因此 admission 控制流是：

```text
AppRuntime builds AdaptiveProjector.node
  → registers every live Adaptive event projector
  → AdaptiveController.start awaits AdaptiveProjector.ready
  → validate input and resolve model
  → AdaptiveStore.createTask admits the Task
```

一次 rebuild 的控制流是：

```text
Task ID
  → EventV2.readAggregate(AdaptiveDurable), ordered by seq
  → preserve adaptive_task / adaptive_agent_process roots and EventTable
  → delete Checkpoint / Assignment / Roadmap revision / Detail rows
  → reset roadmap_revision and Agent derived pointers
  → validate and apply every durable Adaptive event in sequence
  → exact reconstructed query state, or atomic rollback on any conflict
```

### Projection boundary

可以重建的状态由 event payload 中的事实决定：

| Event                                                                                   | 派生结果                                                                                              |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `RoadmapCommitted`                                                                      | 完整 Roadmap revision、内嵌 Details、Task `roadmap_revision`                                          |
| `DetailCommitted`                                                                       | 独立的 immutable Detail version                                                                       |
| `AssignmentCreated`                                                                     | immutable Assignment、Agent node/Assignment/event cursor                                              |
| `CheckpointSaved`                                                                       | immutable Checkpoint、Agent checkpoint/event cursor                                                   |
| generation / recovery / tool / decision / dependency / candidate / context-split events | 校验 Task、Agent、generation、node、Assignment、Roadmap 或 Detail reference；没有对应表时不虚构派生行 |

`TaskCreated` 也只校验 preserved Task root 中可由 payload 证明的 identity、requirement 与 ModelPolicy。Task status、`time_updated`、`base_snapshot_hash` 和 Agent owner/PID/lease 等根事实可能在事件之后合法变化，或从未进入 payload，因此 rebuild 不覆盖它们。

### 关系校验与幂等

每个 handler 先校验 event envelope 的 aggregate 与 `taskID` 一致，再按事件类型检查：

- source Agent 必须属于同一 Task；live generation 必须精确匹配，historical rebuild 或 single-event reproject 的 event generation 都不得超过 preserved current generation。Roadmap Store 发起的错误 source generation 保留公开的 `SourceGenerationMismatch`，不会泄漏成 projector defect。
- Roadmap revision 必须连续，payload hash 必须匹配 canonical encoded Roadmap，所有 node ID 唯一，所有 Detail/Interface reference 必须精确解析到 `key + version + kind + status`。
- immutable Detail 的逻辑 identity 是 Task、key/version、node、kind/status、body 与 content hash；后续 event 重用完全相同内容时保留 first writer 的 source Agent、generation 与 time provenance。
- Assignment 必须指向当前 Roadmap 中存在的 node 和 Details，Worker 必须是同一 Task 的 implementation Agent。
- Checkpoint 必须匹配 active Assignment tuple，sequence 单调递增，`eventCursor` 不得回退或超过保存该 Checkpoint 的 aggregate sequence。
- pointerless `AgentGenerationStarted` 明确把 Agent node / Assignment 写成 SQL `NULL`。full rebuild 按 event sequence 应用历史 generation pointer，即使 preserved root 已经进入更高 generation；single-event reproject 仍保留 anti-regression fence。
- Decision、Candidate 等没有专属 projection table 的事件仍然参与 aggregate 顺序和引用校验，所以它们不会被静默当成无意义的空洞。

exact reprojection 不执行 upsert overwrite：已存在行的 normalized columns 和完整 JSON 必须一致，才允许 no-op 或受约束的指针修复；任何不同都返回 `AdaptiveProjector.ProjectionConflict`。旧 Assignment event 在最新 Checkpoint 之后再次 reproject，也不会把 Agent cursor 降回 Assignment 的旧 sequence。

### 与 S02-T02 commit callback 的并存

`EventV2` 的顺序是 registered projector 先运行、store `commit` callback 后运行。如果两边都盲目 `insert`，正常写入会在同一个事务里 double-write。

最终采用 capability receipt handoff：`EventV2.projector()` 创建稳定 identity，`project()` 注册 handler 时携带它，local commit callback 收到本事务实际运行过的 identity `ReadonlySet`。S02-T02 callback 只有在 receipt set 包含 `AdaptiveProjectorIdentity`、并且当前 event sequence 已经产生完全一致的 row 和 Agent pointers 时才 no-op。没有 Adaptive projector 时原 callback 仍按原逻辑校验和写入；仅注册一个无关的 `CheckpointSaved` projector 不会伪造 Adaptive handoff，也不能把 duplicate save 当成成功。

同一 registration 还携带 replay policy。Adaptive identity 使用 `replay: false`，所以 Workspace generic sync 只落 durable Event rows，不调用依赖 preserved roots 的 projection；Session 和其他未声明 policy 的既有 projector 默认 `replay: true`，兼容原行为。权威派生重建仍只由显式 `AdaptiveProjector.rebuild(taskID)` 触发。

## 推荐代码阅读路线

1. `AdaptiveProjector.Interface` 与 `AdaptiveProjector.layer`：先看公开的 readiness、single-event reprojection、aggregate rebuild，以及所有 durable definitions 的注册位置。
2. `packages/opencode/src/effect/app-runtime.ts` 和 `AdaptiveController.make()`：确认 projector node 在 production AppLayer 中，并且 `start()` 在 validation/admission 前等待 readiness。
3. `apply()`、`projectRoadmap()`、`projectAssignment()`、`projectCheckpoint()`：理解事件分派、三类核心派生写入和 live/reproject/rebuild generation 规则。
4. `requireAgent()`、`requireRoadmapNode()`、`requireDetail()`：理解 Task/Agent/revision/reference 的共同验证边界。
5. `AdaptiveRoadmapStore.commit()` 和 `AdaptiveRecoveryStore.createAssignment()/saveCheckpoint()` 中的 exact callback handoff：确认 projector active 与 inactive 两种 runtime graph 都不会 double-write。
6. `packages/core/test/adaptive/projector.test.ts`：最后从 parity、idempotency、invalid relationship 与 atomic integration 四条真实路径反查实现。

## 术语释义

- **Projection**：直觉上是“把事件翻译成方便查询的表”。工程上它是由权威 event log 确定性计算出的 derived state；本项目具体指 Roadmap/Detail/Assignment/Checkpoint rows 和少量 Task/Agent pointers。
- **Aggregate**：直觉上是一条业务时间线。工程上是共享 aggregate ID、按 `seq` 全序排列的一组 durable events；这里 aggregate ID 就是 `AdaptiveTask.ID`。
- **Reprojection / rebuild**：直觉上是“删掉缓存再算一遍”。工程上要求输入事件相同就得到完全相同的 normalized state；这里不调用 `EventV2.replay()`，而是读取既有 Event rows 后直接运行 projection handlers。
- **Idempotency**：直觉上是“重复执行不改变结果”。这里 exact event + exact projection 是 no-op，不新增 row、不推进 cursor；同一 identity 下的 divergent normalized state 不是幂等重试，而是 corruption/conflict。
- **Projection boundary**：直觉上是“哪些列可以从事件重新算出来”。这里明确排除没有完整 payload 依据的 Task/Agent root 与 process-control facts，避免恢复代码发明数据。
- **Capability receipt handoff**：projector 已在当前 event transaction 中完成写入时，后置 commit callback 先以同一 identity object 的 receipt 证明权威 projector 确实运行，再通过 row、pointer 和 event sequence 的完全一致性确认结果，而不是再次写入。

## 测试看护逻辑

| 风险                                         | 测试方法                                                                                 | 关键断言                                                       | 证明范围                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 删除 projection 后无法恢复                   | `rebuilds exact recovery projections from the existing durable aggregate`                | rebuild 前后所有派生 rows deep equal                           | Roadmap revisions、两类 Detail、Assignment、Checkpoint 和 pointers 可由已有 events 重建 |
| rebuild 误删权威事实                         | 同一 parity 测试                                                                         | Task/Agent root selection 与全部 Event rows 前后相等           | rebuild 不删除 Event log，也不覆盖事件无法证明的 root facts                             |
| EventV2 exact replay 不触发 projector        | 同一 parity 测试直接调用 `rebuild(taskID)`                                               | Event rows 保持原样而 projections 恢复                         | 显式 rebuild path 不依赖重新插入事件                                                    |
| 重复 reproject 产生 duplicate 或 cursor 回退 | `accepts exact reprojection...`                                                          | 两次 exact 后 snapshot 不变、cursor/checkpoint pointer 不变    | single-event idempotency 与旧 event 不回退指针                                          |
| corruption 被 upsert 覆盖                    | 同一 idempotency 测试                                                                    | 修改 Assignment normalized column 后返回 `ProjectionConflict`  | divergent row 被拒绝，不被 event payload 静默覆盖                                       |
| 单 event reproject 留下部分 Detail           | `rolls back partial Details when Roadmap reprojection rejects a missing reference`       | typed `MissingDetailReference` 后完整 snapshot 不变            | reproject 的 immediate transaction 回滚所有已写 projection                              |
| 无派生表事件破坏顺序                         | parity fixture 加入 `TaskCreated`、`DecisionRecorded`、`CandidateSubmitted`              | Event seq 保持连续且最终 projection parity                     | no-row events 被读取和校验，不会改变派生 cursor                                         |
| 关系错误污染 event log                       | `rejects invalid generation, revision, and Detail references...`                         | 三类 publish 均失败且 Event count 不变                         | projector validation 与 Event write 同事务回滚                                          |
| projector 与 T02 callback double-write       | `keeps projector-backed normal store writes atomic...`，以及 fixture 的正常 store writes | 正常写成功；失败 Roadmap 的 Detail、revision、Event 全部不落盘 | projector node active 时 live store 的成功与失败路径仍原子                              |
| 无关 projector 伪造 handoff                  | `does not trust an unrelated Checkpoint projector as the Adaptive Store handoff`         | duplicate 返回 typed sequence conflict，Event count 不增加     | Store 只信任 Adaptive identity receipt                                                  |
| generic sync 缺少 Adaptive roots             | `keeps generic replay durable without projecting Adaptive rows...`                       | 全部 Event rows 导入、Task root 仍不存在                       | sync 保留事实但不调用 root-dependent Adaptive projector                                 |
| pointerless generation 留下旧 Assignment     | `clears Agent node and Assignment pointers...`                                           | node / Assignment 为 `NULL`，cursor 前进                       | optional payload 字段不会被 Drizzle 当作“忽略更新”                                      |
| preserved generation 使 rebuild 跳过历史指针 | `rebuilds later historical generation pointers...`                                       | newer root 下 rebuild snapshot parity                          | full rebuild ordering 与 single-event anti-regression 分离                              |
| 相同 Detail 重用改写 first-writer provenance | 两条 `preserves first-writer Detail provenance...`                                       | active write 与 rebuild 后 source/generation/time 不变         | immutable equality 不包含 later provenance                                              |
| exact row 存在但 Agent pointer 被清空        | 两条 `repairs exact Assignment/Checkpoint pointers...`                                   | 当前 event 修复；cursor 99 / sequence 3 不回退                 | repair 与 anti-regression 同时成立                                                      |
| Store validation 泄漏 projector defect       | `preserves the Roadmap Store source-generation error...`                                 | typed `SourceGenerationMismatch` 且 Event count 不变           | Store API 的 advertised error taxonomy 保持稳定                                         |
| controller 先 admission 后 projector ready   | `does not validate or admit a task until the projector is ready`                         | ready Deferred 释放前 0 次、释放后 1 次 `createTask`           | production Controller 对 injector projector readiness 的真实 admission gate             |

这些测试没有证明跨进程并发 rebuild fencing、远程数据库支持或自动执行 rebuild；它们也不声称可以从当前事件契约重建被明确排除的 root/process facts。

## 亲手验证

先运行 projector、EventV2 和受 exact handoff 影响的 stores：

```bash
cd packages/core
bun test test/adaptive/projector.test.ts test/event.test.ts test/adaptive/roadmap-store.test.ts test/adaptive/recovery-store.test.ts
bun typecheck
```

预期观察：两个命令都以 exit code `0` 结束；projector suite 中十四条测试通过，组合测试没有 duplicate row、stale cursor、partial Detail、provenance 改写或未回滚 Event。若 parity 失败，先比较 `snapshot` 中的 Roadmap `event_sequence`、Detail `time_created` 和 Agent pointers；若 publish 失败但 Event count 增加，应立即检查 `EventV2.commitDurableEvent()` 的 transaction 边界。

本任务没有修改 schema，仍应验证 migration drift：

```bash
cd packages/core
bun script/migration.ts --check
```

预期输出包含 `No schema changes, nothing to migrate`。

最后运行 tutorial validator 自身的自动化测试：

```bash
cd script
bun test adaptive-tutorial-check.test.ts
```

预期 19 条测试全部通过。PR CI 还会在带有 `GITHUB_EVENT_PATH` 的 GitHub Actions 环境中运行 `bun script/adaptive-tutorial-check.ts`，检查本文件没有遗留 `tutorial:` marker、路径与 S02-T03 匹配，并且同一 PR 更新了教程索引；该命令在普通本地 shell 中缺少 PR event 时会明确拒绝运行。

## 当前边界与下一步

本任务已经把 Core projector readiness 接入 production Controller admission；它仍然没有把 rebuild 自动挂到启动流程。何时选择、fence 并执行 rebuild 仍属于后续恢复编排任务，避免把启动 admission 与恢复策略混为一谈。

当前 rebuild 假设单一进程在事务内独占同一 SQLite Task projection。跨进程 rebuild lease/fencing、在线增量 catch-up 和运维 CLI 也不在本任务范围内。

S02-T04 起的 Context Renderer/Assembler 可以把 rebuilt Roadmap、Detail、Assignment 与 Checkpoint 当作结构化输入；后续 replacement Worker recovery 则负责把这些 durable claims 与实际 Git HEAD、diff、key files 和 evidence 再核对一次。Projector 保证“数据库能从事件重建”，但不会把 Checkpoint 声明自动等同于 workspace 事实。
