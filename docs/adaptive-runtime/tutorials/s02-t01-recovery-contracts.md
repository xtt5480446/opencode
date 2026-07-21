# S02-T01：可恢复开发状态的公共契约

## 先说结论

S02-T01 定义了 Adaptive Runtime 用来描述“软件开发现场”的三组公共契约：完整 Roadmap 索引、Worker 工作交接状态，以及可回放的 Task 事件。它让后续模块能够用同一种无歧义的数据语言持久化、重建和审计 Agent 工作，而不依赖某个进程内的聊天记录。

本任务没有创建 SQLite 表，没有组装模型 prompt，也没有实现 Worker 重启。它交付的是这些能力共同依赖的 Schema 和 Event manifest；真正的持久化、投影、上下文组装和强制恢复分别由 S02-T02、T03、T04-T05 和 T08 完成。

## 它在当前 Milestone 中的位置

G2 要证明 Worker 和 Coordinator 的进程上下文丢失后，系统仍能仅凭外部事实完成一个真实 coding task。S01 已经提供 Task、ModelPolicy、ContextManifest、Agent generation 和独立子进程边界，但还不能表达某个 Worker 正在负责哪个节点、已经做了什么、磁盘现场是否与交接记录一致。

S02-T01 补上这套公共语言：

```text
G1 accepted Task / Agent / ContextManifest identity
  -> S02-T01 Roadmap + Operation + durable Event contracts
  -> S02-T02 immutable SQLite storage
  -> S02-T03 replayable projections
  -> S02-T04/T05 deterministic context reconstruction
  -> S02-T06/T07 Worker tools and provider turns
  -> S02-T08 forced process recovery
  -> S02-T09 G2 coding fixture
```

这对短上下文目标的直接价值是：模型不需要携带完整开发历史。每轮只需读取完整 Roadmap、当前 Assignment、精确 Detail、最新 Checkpoint、真实 workspace 状态和尚未消费的事件。

## OpenCode baseline 与复用边界

OpenCode 已经有成熟的 browser-safe Schema 和事件定义框架。`Event.define` 负责建立统一事件 envelope，`Event.inventory` 保存 canonical definition，`Event.latest` 为公共订阅面选择每个事件类型的最新版本，`Event.durable` 则用 `type.version` 建立持久事件索引。现有 Session 事件已经按同样方式注册到 `EventManifest` 和 `DurableEventManifest`。

S02-T01 直接复用了这些基础设施：

- 复用 Effect `Schema.Class`、closed literal、brand 和现有 `optional` 编码规则。
- 复用 S01 的 `AdaptiveTask.ID`、`AgentID`、`Role` 和 Task summary，不创建重复身份。
- 复用 `Event.define/inventory/latest/durable`，不创建第二套 event bus 或 serializer。
- 复用 `RelativePath` 品牌类型，使 Assignment 和 Checkpoint 与 OpenCode 的路径契约一致。

不能直接复用的是 Session history 的业务语义。Session 事件描述 prompt、assistant message 和 tool message 的对话生命周期；Adaptive 事件描述 Roadmap revision、Assignment、Checkpoint、恢复核验和 candidate 等开发状态。两者共用事件框架，但 Adaptive 事件以 `taskID` 聚合，恢复时也不会读取 Session 对话历史。

## 最终实现

### Roadmap 是完整导航索引

`AdaptiveRoadmap.Info` 固定一个 Task 在某个 revision 的完整全局骨架。它保留原始 `RequirementBaseline`，并列出全部节点。每个 `Node` 都暴露目标、状态、接口摘要、依赖、Detail 引用、验收条件、风险和正式 unresolved 项。

接口摘要不是完整实现文档。`InterfaceRef` 只放足以让其他节点识别边界的名称、类型、签名和 `key@version`；需要参数、错误和 schema 全文时，Worker 再按 `DetailRef` 精确打开对应版本。这样 Roadmap 可以保持轻量，同时不会用“当前最新版”这种含糊引用破坏恢复确定性。

依赖类型被限制为四种：

- `hard`：目标节点完成前必须具备的实现依赖。
- `contract`：可以并行，但必须遵守已冻结接口。
- `informational`：按需读取的背景信息，不应伪装成正确性前置条件。
- `validation`：只在验证或集成阶段需要。

### Operation 是 Worker 的结构化交接包

`AdaptiveOperation.Assignment` 是不可变工作单，固定 Task、Worker、node、Roadmap revision、精确 Detail refs、允许路径、base commit、验收命令和 Agent generation。

`Checkpoint` 保存替代 Worker 接班所需的事实：已经完成和仍待完成的工作、带版本的决定引用、修改路径、Evidence 引用、下一步动作、预期 HEAD/diff hash，以及 `eventCursor`。`eventCursor` 表示这个 Checkpoint 已经消费到哪个 Task event sequence；Context Assembler 只加载它之后的事件，避免重复或遗漏。

`RecoveryVerification` 是替代 Worker 的只读现场核验报告。它记录实际 HEAD、diff hash、porcelain status、关键文件 hash、重新验证的 Evidence 和所有差异。只有 `consistent=true` 且 Controller 验证事实匹配时，后续 Tool Gateway 才能开放写工具。

`CandidateReport` 记录 Worker 声称完成时的 commit、diff、修改路径、Evidence、剩余风险和 Detail refs。它只把节点送入 candidate，不等同于 validation、integration 或 Task completion。

### Event 是可重放的事实边界

`AdaptiveEvent` 定义了 14 个 version 1 durable events，全部以 `taskID` 聚合。它们覆盖 Task/Roadmap/Detail/Assignment 创建，Agent generation 启停，恢复核验，Tool 调用与结算，决定与依赖报告，Checkpoint、candidate 和 context split。

事件 payload 携带重建投影需要的完整业务值，而不是只保存一段描述文字。例如 `CheckpointSaved` 包含完整 `Checkpoint`，`RoadmapCommitted` 包含完整 Roadmap 和 content hash。Tool input/output 只允许最多 8192 字符的 preview；更大内容必须在后续 Store 中写入 blob，并由 hash 引用。

```text
Domain value
  -> Effect Schema validation
  -> Event.define canonical envelope
  -> EventManifest.Latest for current subscribers
  -> DurableEventManifest type.version index
  -> S02-T02 EventV2 publication and SQLite transaction
```

Agent generation 使用 `PositiveInt`，因此 generation 0 会在公共契约边界失败。Assignment ID 使用严格 `aas_` 加 26 字符格式，避免任意字符串进入持久关联字段。

## 推荐代码阅读路线

1. `packages/schema/test/adaptive-contract.test.ts`：先看一份 Roadmap 和 Checkpoint 在调用侧长什么样，以及哪些非法输入必须被拒绝。
2. `packages/schema/src/adaptive-roadmap.ts` 的 `Info`、`Node`、`InterfaceRef` 和 `DetailRef`：理解全局索引与按需 Detail 的边界。
3. `packages/schema/src/adaptive-operation.ts` 的 `Assignment`、`Checkpoint`、`RecoveryVerification` 和 `CandidateReport`：理解 Worker 从接单到交接、恢复和提交 candidate 的状态链。
4. `packages/schema/src/adaptive-event.ts` 的 `DurableDefinitions`：观察哪些变化被定义为可回放事实，以及每种事件携带什么值。
5. `packages/schema/src/event-manifest.ts` 和 `durable-event-manifest.ts`：确认 Adaptive 沿用 OpenCode 的 current/versioned 事件发现机制。
6. `packages/schema/test/event-manifest.test.ts`：查看 canonical identity、aggregate 和 version 注册的回归断言。

## 术语释义

**Wire contract**：直觉上是模块之间共同认可的数据语言；工程上是可编码、可验证、可版本化的 Schema。本任务的契约会跨 Schema、Core、Controller、Agent process 和未来 HTTP client 使用。

**Aggregate**：一组事件共同描述的业务实体。Adaptive durable events 的 aggregate 是 `taskID`，因此同一个 Task 的事件拥有独立递增序列，可按游标恢复。

**Projection**：从事件序列计算出的便于查询的当前状态表。S02-T01 只定义事件；S02-T03 会证明删除 projection 后可以从这些事件重建相同状态。

**Checkpoint**：不是聊天摘要，而是可验证的工作交接点。它必须同时说明语义进展、代码现场标识和事件消费位置。

**Canonical definition**：一个事件类型只有一个权威 Schema 对象。公共 latest manifest、durable manifest 和业务模块都引用同一个对象，避免同名但结构不同的事件。

**Bounded preview**：Tool 大输出不会直接塞入事件或后续 prompt，只保留固定上限的可读片段；完整内容用 content-addressed blob 保存。这防止日志把 Roadmap 和局部上下文挤出预算。

## 测试看护逻辑

| 风险                                         | 测试方法                          | 关键断言                                                               | 证明范围                                      |
| -------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| Roadmap 编解码丢失接口或引用版本             | 构造完整 Roadmap 后 encode/decode | `contract:retry-api@2` 和全部节点字段不变                              | 证明 wire round trip，不证明 Roadmap 业务自洽 |
| 替代 Worker 缺少交接事实                     | 构造 Assignment 与 Checkpoint     | Assignment、下一步动作、HEAD/diff 和 `eventCursor` 可读取且 round trip | 证明数据可表达，不证明恢复流程会使用它        |
| 非法 generation 进入持久状态                 | 解码 generation 0                 | Schema 抛错                                                            | 证明公共契约拒绝 0，不证明 Store 的 CAS       |
| Tool 日志无限增长                            | 解码 8193 字符 preview            | Schema 抛错                                                            | 证明字符上限，不证明 runtime 已完成 blob 写入 |
| Adaptive 事件漏出 current 或 durable surface | 遍历全部 durable definitions      | aggregate=`taskID`、version=1、latest/versioned identity 相同          | 证明 manifest 注册，不证明事件已被发布        |
| 破坏既有 Session/V1 事件兼容顺序             | Schema 全量 event-manifest 回归   | 既有 count、identity 和相邻顺序仍成立                                  | 证明本包事件表面兼容，不代表全仓运行回归      |

测试有意不声称以下能力已经完成：SQLite 原子写、事件 replay、ContextManifest 重建、Tool side-effect 去重、真实进程强杀恢复。这些分别属于后续 G2 Tasks。

## 亲手验证

从 Schema package 运行聚焦测试：

```bash
cd packages/schema
bun test test/adaptive-contract.test.ts test/event-manifest.test.ts test/contract-hygiene.test.ts
bun typecheck
```

预期观察：12 个聚焦测试全部通过，typecheck 退出码为 0。`adaptive-contract.test.ts` 应展示完整 Roadmap/Assignment/Checkpoint 用法；`event-manifest.test.ts` 应遍历 14 个 Adaptive definitions，而不是手工只检查其中几个。

再运行包级回归：

```bash
cd packages/schema
bun test
```

预期观察：29 个测试通过、0 失败。若 manifest count 或 Session/V1 相邻顺序失败，优先检查 `event-manifest.ts` 的注册位置；若 branded path 在 typecheck 失败，应使用 `RelativePath.make(...)`，不能把生产契约放宽为普通字符串。

公共 manifest 还有一个 OpenCode package 消费者测试：

```bash
cd packages/opencode
bun test test/event-manifest.test.ts
```

预期观察：2 个测试通过、0 失败，并确认 OpenCode runtime 与 Schema package 使用同一个 `AdaptiveEvent.CheckpointSaved` definition。

## 当前边界与下一步

S02-T01 只冻结了恢复状态的数据语言。它没有验证引用的 Detail 真实存在，没有保证 Roadmap revision CAS，没有把事件与 projection 放进同一个数据库事务，也没有控制替代 Worker 的写权限。

S02-T02 将建立 Roadmap/Detail/Assignment/Checkpoint/blob 的不可变存储和事务事件提交；S02-T03 将验证 projection replay；S02-T04/T05 才把这些值确定性渲染并装配进有预算的 ContextManifest。到 S02-T08，真实替代进程才会用 `RecoveryVerification` 通过只读核验后恢复编辑。
