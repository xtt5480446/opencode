# S02-T02：可恢复开发状态的持久化底座

## 先说结论

S02-T02 把上一任务定义的 Roadmap、Detail、Assignment 和 Checkpoint 从“可表达的数据结构”变成了进程退出后仍然存在、能够精确读回的 SQLite 权威状态。它同时提供 content-addressed Blob Store，把大型 Tool 输出放到数据库外，并用 SHA-256 保证恢复时读到的仍是原始内容。

本任务还没有让 Worker 自动编码，也没有组装 system prompt 或真正重启 Agent。它解决的是恢复链最底层的问题：后续进程即使一字不记得，也有一组不可变、可校验、与 durable event 原子提交的事实可读。真正可由用户观察的强制重启 coding 演示将在 S02-T09/G2 提供。

## 它在当前 Milestone 中的位置

S02-T01 只规定了恢复状态“长什么样”；如果这些对象仍只活在 Coordinator 或 Worker 内存中，进程一死就没有任何恢复价值。S02-T02 因此是整个 G2 数据链的落盘边界。

```text
S02-T01 Roadmap / Assignment / Checkpoint / Event contracts
  → S02-T02 immutable SQLite state + content-addressed blobs
  → S02-T03 projection replay
  → S02-T04/T05 deterministic ContextManifest reconstruction
  → S02-T06/T07 durable tools and Agent loop
  → S02-T08/T09 forced recovery and G2 coding fixture
```

它对短上下文 Agent 的价值不在于“存得更多”，而在于让后续 Context Assembler 能精确选择：完整 Roadmap r3、`contract:x@2`、Assignment、Checkpoint 7、Checkpoint 之后的事件和某个 hash 对应的大输出。模型不必重新读完整历史，也不会把“当前最新版”误当成过去决策所依赖的版本。

## OpenCode baseline 与复用边界

OpenCode baseline 已经有三块成熟基础设施，本任务直接复用而没有另起炉灶。

第一块是 `Database.Service` 和 Drizzle SQLite schema。S01 的 `AdaptiveStore` 已用它保存 Task、Agent generation、ContextManifest 和 ModelRequest；本任务继续在同一数据库中增加表，并使用同一个 migration generator、registry、fresh-schema snapshot 和升级测试。

第二块是 `EventV2.publish(..., { commit })`。OpenCode 的 durable event 提交会在一个 SQLite transaction 中依次运行 projector、本地 projection commit、event sequence 和 event row 写入。`AdaptiveRoadmapStore` 与 `AdaptiveRecoveryStore` 直接使用这条原子路径，所以不会出现“Roadmap 已更新但事件没写”或“Checkpoint event 存在但 latest pointer 没变”的半完成状态。

第三块是现有 `Global.Service`、`Hash.sha256`、Effect service/layer 和 typed error 模式。Blob 的根目录来自可替换的 Global data path；测试可以隔离到临时目录，生产则自然落到 OpenCode data directory。

没有复用的是 Session transcript 与 compaction。Session history 仍服务 baseline 对话执行；Adaptive Roadmap/Checkpoint 不会写进 Session message，也不会从旧聊天摘要恢复。现有 `ToolOutputStore` 负责单次 Session tool settlement 的有界展示和临时 retention，而 Adaptive Blob Store 需要跨进程、按 canonical hash 精确寻址，因此两者用途不同，不能把临时 output path 当成恢复事实。

## 最终实现

### Roadmap 与 Detail：版本不可变，引用必须精确存在

`AdaptiveRoadmapStore.commit` 接收 `expectedRevision`、完整下一版 Roadmap、同一提交新增的 Detail，以及来源 Agent/generation。调用先检查 revision 必须恰好加一、node ID 唯一、Detail body 与 content hash 一致；真正的 CAS、来源 generation 和引用检查则在 durable event 的 transaction 内再次执行。

```text
complete Roadmap rN + new Detail versions
  → validate shape and SHA-256
  → EventV2 durable transaction
      → compare Task.roadmap_revision with expectedRevision
      → verify source Agent generation
      → insert immutable Details
      → resolve every DetailRef and InterfaceRef by exact key@version
      → insert Roadmap revision and advance Task pointer
      → append adaptive.roadmap.committed.N event
  → return RoadmapRecord
```

`adaptive_roadmap_revision` 保留每一版完整 Roadmap、Requirement copy、canonical content hash、来源 Agent/generation 和对应 event sequence。`adaptive_detail` 的主键是 `(task_id, key, version)`；相同版本重复提交相同内容可以安全重试，任何 body、hash、kind、status 或 owner node 不同都会返回 `ImmutableDetailConflictError`，原值不会被覆盖。

Roadmap 引用不存在的 `contract:x@2` 时，整个 transaction 失败：不会推进 Task revision，不会留下 Roadmap row，也不会留下 durable event。这里的“精确”很重要；恢复不能把缺失的 `@2` 静默替换成 `@1` 或未来的 `@3`。

### Assignment 与 Checkpoint：交接记录必须匹配真实现场

`AdaptiveRecoveryStore.createAssignment` 检查 Task 当前 Roadmap revision、Worker role/generation、node 是否存在，以及每个 Detail ref 是否精确可解析。成功后，Assignment row、Agent 当前 node/assignment/event cursor 和 `AssignmentCreated` event 在一个 transaction 中提交。

恢复读取把 Assignment 的 `detail_refs`、`permitted_paths`、`acceptance_commands` 当作不可信 JSON text：先解析三列，再用完整 Assignment schema 连同 normalized columns 一次校验。语法损坏、字段形状错误或非法 repository glob 都返回 typed `CorruptAssignmentError`；`saveCheckpoint` 也复用这条读取边界，因此损坏的 authoritative Assignment 不能继续产生新交接点。

`saveCheckpoint` 不盲信模型提交的 HEAD 与 diff hash。Controller 必须把自己刚观察到的 `observedHead` 和 `observedDiffHash` 一并传入；任意不一致都会先返回 `WorkspaceStateMismatchError`。transaction 内还会重新检查 Worker generation、active Assignment tuple、Roadmap revision 和连续 Checkpoint sequence。

```text
model-proposed Checkpoint + Controller-observed HEAD/diff
  → exact workspace comparison
  → verify active Worker generation and Assignment
  → require sequence = latest + 1
  → insert immutable Checkpoint row
  → advance Agent checkpoint_sequence / event_cursor
  → append CheckpointSaved event atomically
```

`adaptive_checkpoint` 的主键是 `(worker_id, sequence)`，因此 Checkpoint 1 不会在保存 Checkpoint 2 后消失。`getCheckpoint(worker, 1)` 能读取旧交接点，`getLatestCheckpoint(worker)` 通过 Agent 的 durable pointer 返回最新交接点。测试关闭第一个 Database layer 后重新打开同一个 SQLite 文件，确认这两个读取语义仍成立。

Assignment 上的 generation 表示首次派发它的 generation，而 Agent 当前 `assignment_id` 才表示谁在继续执行这张工作单。Agent lease 过期并被 generation 2 接管时，`claimAgent` 会保留 Assignment、Checkpoint 和 cursor pointer；generation 2 可以在先完成恢复核验后继续同一 Assignment，不需要篡改旧 Assignment 或丢掉 generation 1 的历史 Checkpoint。保存新 Checkpoint 时检查的是当前 Agent generation 和 active Assignment ID，而不是错误地要求 immutable Assignment 的初始 generation 永远等于替代进程。

Checkpoint cursor 也不能倒退。新 cursor 必须大于等于 Agent 已持久化的 cursor，并且不能超过正在提交的 `CheckpointSaved` event sequence；违反任一边界都会返回 `CheckpointCursorConflictError`，transaction 不会留下 row、pointer 或 event。读取时还会把 JSON 内的 Worker、sequence、Assignment、generation、Roadmap revision、HEAD、diff、cursor、timestamp 与 normalized columns 逐项比较，不一致返回 typed `CorruptCheckpointError`。

### Blob：内容就是地址，读取时再次验真

`AdaptiveBlobStore.put` 对完整 bytes 计算 SHA-256，并写入：

```text
<Global.data>/adaptive/blobs/sha256/<first-two>/<64-char-digest>
```

文件先在目标目录创建临时文件、写入并 `fsync`，再 rename 到 content-addressed 路径，最后写 `adaptive_blob` metadata。同一 bytes 重复 `put` 会得到同一 hash 和同一 metadata row，不会制造第二份文件；前一次崩溃若留下“有文件但无 metadata”的 orphan，后一次提交会先验 hash 再补 metadata。

`read` 不因为路径来自数据库就直接信任文件。它先从已校验的 SHA-256 重新推导 canonical relative path，要求 metadata `relative_path` 完全相等；不一致时在任何文件系统读取或 quarantine 之前直接返回 `BlobCorruptError`。路径一致后才读取并重新比较 byte count 和 SHA-256；bytes 不匹配时只把 canonical 文件 rename 为 `.corrupt-<time>`，绝不会访问 metadata 指向的外部路径或把损坏内容送入恢复上下文。

文件系统还没能返回 bytes 时则不能武断地宣布“内容损坏”。例如 path 暂时不可读、文件描述符耗尽或 canonical path 意外变成目录时，`read` 保留原路径并返回 `BlobIOError`；只有实际读到 bytes 后确认长度/hash 不匹配，才进入 quarantine。这给上层重试临时 I/O 故障留下了正确空间。

### Migration 与 ContextManifest 恢复字段

新 migration 是 `20260721092343_adaptive_recovery_state`，时间顺序晚于 Stage 1 最后一项 migration。它只创建五张新表并为现有 Agent/ContextManifest 使用 `ALTER TABLE ADD COLUMN`，没有重建旧表。

Agent process 新增 node、tool Session、Assignment、event cursor、Checkpoint pointer、recovery state 和 restart-required 字段。ContextManifest 新增 omissions、Roadmap revision、turn 和 restart reason；`AdaptiveStore.putManifest/getManifest` 已能往返这些值。旧 Stage 1 row 升级后得到安全默认值：空 omissions、Roadmap r0、turn 0、Agent `ready`、event cursor 0，同时原 Agent、Manifest、ModelRequest 和 Bootstrap 保持不变。

## 推荐代码阅读路线

1. `packages/core/test/adaptive/roadmap-store.test.ts`：先看 CAS、Detail 不可变和 exact reference 三个最核心不变量。
2. `packages/core/src/adaptive/roadmap-store.ts` 的 `commit`：观察 `EventV2.publish` 的 commit callback 如何把 Roadmap、Details、Task pointer 和 event 绑在一个 transaction 中。
3. `packages/core/test/adaptive/recovery-store.test.ts`：看 stale generation、HEAD/diff mismatch 和真正关闭/重开数据库后的读取行为。
4. `packages/core/src/adaptive/recovery-store.ts` 的 `createAssignment` 与 `saveCheckpoint`：理解模型提议状态与 Controller 验真之间的边界。
5. `packages/core/test/adaptive/blob-store.test.ts` 和 `packages/core/src/adaptive/blob-store.ts`：理解 dedup、verified read 与 corruption quarantine。
6. `packages/core/src/adaptive/sql.ts`：最后看五张表和 Agent/Manifest 扩展列，避免一开始陷入字段列表。
7. `packages/core/test/database-migration.test.ts` 的 recovery storage case：确认升级保真不是只靠 schema diff 推断。

## 术语释义

**Compare-and-swap（CAS）**：直觉上是“只有我看到的版本仍是当前版本，才允许提交下一版”。工程上会同时比较 expected revision 与数据库 current revision；不相等就返回 stale error。本项目用它阻止两个 Coordinator 基于同一个旧 Roadmap 互相覆盖。

**Immutable version（不可变版本）**：同一个 `key@version` 一旦存在就永不改写。要改变内容只能创建新 version，并让下一版 Roadmap 显式引用它。这让任何历史 Assignment 都能重新拿到当时真正看到的接口全文。

**Content-addressed storage（内容寻址存储）**：文件名来自内容 hash，而不是创建者起的名字。相同 bytes 天然去重，读取时可重算 hash 验证身份。本项目用它保存不适合直接塞进 event/ContextManifest 的完整 Tool 输出。

**Atomic commit（原子提交）**：一组写入要么全部成功，要么全部回滚。这里 Roadmap/Checkpoint projection 与 durable event 是同一 transaction；不能只完成其中一半。

**`fsync`**：要求操作系统把已写数据刷新到稳定存储，而不只是留在进程或内核缓存。它降低 Controller 在写 Blob 途中崩溃时留下“metadata 已承诺但文件未落稳”的风险。

**Quarantine（隔离）**：发现文件损坏后不继续使用，也不静默删除，而是移出 canonical 路径并保留带标记的文件，便于诊断。后续相同 hash 不会误读这份损坏内容。

## 测试看护逻辑

| 风险 | 测试方法 | 关键断言 | 证明范围 |
| --- | --- | --- | --- |
| stale Coordinator 覆盖新 Roadmap | revision 1 成功后再次以 expected 0 提交 | `StaleRevisionError`；原 Roadmap 与 Task pointer 不变 | 证明 Store CAS 与 transaction rollback，不证明 T03 replay |
| 相同 Detail version 被篡改 | 用不同 body 提交同一 `key@version` | `ImmutableDetailConflictError`；原 body/hash 保留 | 证明版本不可变，不判断 Detail 业务内容是否正确 |
| Roadmap 引用不存在 Detail | 引用缺失 `contract:x@2` | 无 Roadmap row、无 event、Task 仍为 r0 | 证明 exact reference 原子门禁 |
| 旧 Worker 保存 Checkpoint | 使用 stale generation | `StaleGenerationError`；latest sequence 不变 | 证明 generation CAS，不证明 OS 进程已经被杀死 |
| 模型伪报工作区状态 | Controller observed HEAD/diff 与 Checkpoint 不同 | `WorkspaceStateMismatchError`；无新 Checkpoint/event | 证明 Store 拒绝不一致输入，真实 Git 检查由 T06/T08 接入 |
| replacement generation 无法接班 | generation 1 保存 Checkpoint 后让 lease 过期，由 generation 2 接管同一 Agent | immutable Assignment 不变；generation 2 成功保存下一个 Checkpoint | 证明持久状态接班路径可达，T08 再证明真实进程强杀 |
| 新 Checkpoint 让 event cursor 倒退 | sequence 2 提交小于当前值的 cursor | `CheckpointCursorConflictError`；latest 仍为 sequence 1 | 证明事件消费边界单调且 transaction 回滚 |
| 重启后只剩最新摘要 | 保存 sequence 1、2，关闭并重开数据库 | latest 是 2，sequence 1 仍可按号读取 | 证明 durable version history |
| recovery JSON 损坏或与 normalized columns 分叉 | 写入 malformed/invalid Assignment JSON，或修改 Roadmap/Detail body、Checkpoint JSON 而不同步 hash/normalized columns | typed `CorruptAssignment`、`CorruptRoadmap`、`CorruptDetail`、`CorruptCheckpoint` | 证明读取不会静默信任损坏或有效但矛盾的 JSON |
| 大输出重复占空间或被破坏 | 相同 bytes put 两次，再手工修改文件 | 同 hash、单 row/单文件；read 返回 `BlobCorruptError` 并 quarantine | 证明单 Controller 下的 dedup 与 verified read；Stage 6 再补 quota/retention |
| Blob metadata 指向外部路径 | 把 `relative_path` 改成 traversal path，指向外部 sentinel | 返回 `BlobCorruptError`；sentinel 未被读取或 quarantine | 证明 content hash 才能决定文件路径，持久化路径不是 I/O authority |
| 暂时 I/O 故障被误判为内容损坏 | 让 canonical path 在 read 前不可作为普通文件读取 | 返回 `BlobIOError`；路径未被 quarantine | 证明只有已读取 bytes 的 hash mismatch 才判 corrupt |
| 升级破坏 Stage 1 状态 | 在旧 schema 插入 Agent/Manifest/Request/Bootstrap 后运行 migration | 所有旧行保持，新增列为安全默认，FK check 为空 | 证明该 migration 的升级保真 |
| 新列没有进入 Store API | Manifest 写入 recovery fields 后立即读取并重开读取 | omissions/revision/turn/reason 完整往返 | 证明 Manifest 存储，不证明 Context Assembler 已使用它们 |

自动化测试有意没有证明：模型能完成 coding、Worker/Coordinator 能被真实强杀、ContextManifest 能在 256k 预算内正确装配、Tool side effect 能 exact-once 恢复。这些仍属于 S02-T05 到 T09。

## 亲手验证

从 Core package 运行本任务聚焦测试：

```bash
cd packages/core
bun test \
  test/adaptive/roadmap-store.test.ts \
  test/adaptive/recovery-store.test.ts \
  test/adaptive/blob-store.test.ts \
  test/adaptive/store.test.ts \
  test/database-migration.test.ts
bun typecheck
bun script/migration.ts --check
```

预期观察：所有测试通过，typecheck 退出码为 0，migration check 输出 `No schema changes, nothing to migrate`。如果 Roadmap 测试失败，应先检查 event transaction 是否同时回滚 `adaptive_task.roadmap_revision` 和 event row；如果 Blob corruption 测试失败，应检查 canonical 文件是否仍留在原路径；如果 upgrade 测试失败，不能通过删除旧行或重建数据库规避。

完整 Core 回归命令为：

```bash
cd packages/core
bun test
```

本任务实现时的完整回归结果是 1147 个测试通过、0 失败。这个数字是该提交的历史证据；未来仓库增加测试后应以当次命令的实际输出为准，而不是要求数字永远相同。

## 当前边界与下一步

S02-T02 已经保证恢复事实可以可靠落盘和精确读回，但目前 normalized tables 仍主要由 live commit 写入。S02-T03 将实现 projector，并证明删除这些 projection 后能仅从 durable events 重建相同状态。

S02-T04/T05 会把 Roadmap、Assignment、Detail、Checkpoint、workspace diff 和 cursor 之后的事件确定性渲染进有预算的 ContextManifest。S02-T06 才把真实 Git 观察和 adaptive tools 接到这些 Store；S02-T08 会启动 replacement generation 的只读 verification phase；S02-T09 最终用真实 fixture 证明多次 Worker/Coordinator 重启后 coding 结果仍正确。

因此这个任务不应单独要求用户做系统验收：它是 G2 必需且可自动验证的底座，但只有后续调用链接通后，用户才能从产品行为上判断恢复机制是否真正成立。
