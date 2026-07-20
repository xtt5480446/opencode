# S01-T09：Controller bootstrap 与 CLI runtime 隔离

## 先说结论

本任务第一次把 Stage 1 已完成的 Task、ModelPolicy、进程监督和 Model Gateway 串成真实 CLI 流程。用户可以显式运行 `opencode run --runtime adaptive`：系统先持久化 Task，再启动一个没有 provider credential 的 Coordinator 子进程，由子进程经 Controller 发起恰好一次模型请求，最后留下可由新 CLI 进程读取和导出的完整审计记录与 bootstrap 结果。

默认或显式 `--runtime baseline` 仍进入原有 OpenCode Session 执行路径。当前 Adaptive Coordinator 只完成一轮固定的 bootstrap 确认，不做代码修改、不创建 Roadmap，也不声称开发任务完成；这些能力属于后续 Stage。

## 它在当前 Milestone 中的位置

S01-T01 至 T08 分别准备了公共 ID/状态、不可变模型策略、SQLite Store、模型解析、审计、进程协议、进程监督和 Model Gateway，但此前没有一条用户命令把它们完整接起来。T09 是 G1 的产品入口，T10 则把同一入口放进 packaged binary 并交给用户使用真实短上下文模型验收。

```text
S01-T03 Store + T04 Model resolver + T05 Audit
  + T06 Protocol + T07 Supervisor + T08 Gateway
  → S01-T09 CLI / Controller / Coordinator bootstrap
  → S01-T10 packaged smoke + G1 user trial
```

这一步对最终目标的价值不是增加一次普通 LLM 调用，而是证明模型只能看到 Controller 根据 durable state 组装的 Manifest。后续即使 Coordinator 或 Worker 上下文清空，也可以沿用同一边界重建新进程，而不是依赖旧 Session transcript。

## OpenCode baseline 与复用边界

修改前，`RunCommand` 通过 `effectCmd` 加载项目 `InstanceContext`，随后进入原有 Promise/SDK 逻辑：解析 `--dir`、message、stdin 和附件，创建或恢复 Session，再由 Session prompt loop 调用 provider、工具和事件流。OpenCode 的 Session、内置 Agent、provider plugin、Config、Catalog 和 model resolver 对 baseline 来说是成熟能力。

T09 直接复用了以下合理实现：

- `effectCmd` 和 `AppRuntime` 继续负责 CLI service graph 与 Instance 生命周期。
- V2 `Config`、config-provider plugin、`Integration`、`Catalog` 和 `SessionRunnerModel.resolveRef()` 继续负责解析真实 `provider/model/variant`，没有再造 provider SDK 或模型目录。
- `AdaptiveProcessSupervisor`、`AgentProcessProtocol` 和 `AdaptiveModelGateway` 分别复用 T07/T08 已验证的进程、RPC 和模型审计边界。
- baseline 的 `RunCommand` 主体没有被抽成新的共享执行器；Adaptive 在它之前做显式分支，baseline 仍执行原代码。

Adaptive 没有复用 Session transcript 作为上下文来源，也没有把 Coordinator 实现成 baseline 内置 Agent 的另一个 mode。这里的广义 Sub Agent 是独立 OS 进程：它收到 Task/Agent/generation/role identity，通过 stdio RPC 请求服务，却不能读取 provider credential、任意 Session history 或 Controller memory。将来可以继续复用 OpenCode 的工具实现，但工具调用也必须由 Controller 按 Manifest 和权限路由，不能退回旧 Session 语义。

为让真实 subprocess 测试使用 OpenCode 已有的 inline config，Core V2 `Config` 现在把 `OPENCODE_CONFIG_CONTENT` 解码成最高优先级 `Config.Document`；它用独立 `source` 保留来源标记，并让 `path` 为空，使相对 plugin/reference 始终从当前 Location 解析。`Catalog` 也把 AISDK `api.settings.apiKey` 识别为可用 credential。这与 `SessionRunnerModel` 原本从同一 settings 读取 key 的行为对齐，文件配置的发现顺序保持不变。

## 最终实现

`RunCommand` 新增 `--runtime baseline|adaptive`，默认值是 `baseline`。Adaptive 分支先拒绝 `--continue`、`--session`、`--fork`、`--command`、`--share`、`--attach`、`--interactive` 和 `--file`，避免旧 Session 控制或附件被静默忽略；拒绝发生在读取 piped stdin 之前。通过校验后才按 baseline 规则解析 `--dir` 和 stdin。不存在的目录直接失败，不会先创建 Task。

一次成功调用的控制流如下：

```text
opencode run --runtime adaptive --model provider/model "requirement"
  → validate incompatible CLI options; resolve directory and stdin
  → wait for config-provider; reload Integration and Catalog
  → SessionRunnerModel.resolveRef(exact provider/model/variant)
  → create immutable ModelPolicy and durable Task(status=planning)
  → emit adaptive.task.created with durable Task ID
  → create Coordinator Agent(generation=0)
  → Supervisor spawns hidden __adaptive-agent and validates hello
  → Store atomically claims generation=1 / owner / PID
  → Controller prepare() writes the generation-bound bootstrap Manifest
  → Supervisor sends accepted; child sends ready
  → child calls model.stream(null)
  → Controller routes the request through AdaptiveModelGateway
  → Gateway loads Task policy + Manifest, streams canonical events, settles audit
  → child collects text-delta and calls process.complete
  → Store atomically requires Request=succeeded and writes adaptive_bootstrap
  → Supervisor settles Agent as stopped; Controller emits bootstrap.completed
```

`prepare(identity)` 是本任务对 Supervisor 增加的唯一时序接口。它只能在 durable generation claim 成功后、`accepted` 发给 child 之前运行，因此 Manifest 中的 generation、owner 和 PID 一定来自真实 claim，而不是 Controller 的预测。若写 Manifest 失败，Supervisor 会终止 child 并把该 generation 结算为 `failed`。

Coordinator 的入口是 `runAdaptiveRole()`。它不加载 AppRuntime，也不自行选择模型；coordinator role 只调用一次 `context.modelStream(null)`，收集 `text-delta`，再提交结构化 `{ type: "bootstrap.completed", bootstrap }`。Controller 不会仅凭这条 RPC 宣布成功：它先 trim 并拒绝空白 bootstrap，随后 `AdaptiveStore.completeBootstrap()` 必须在同一事务中确认 Task/Agent/generation/Manifest/Request 完全一致、Agent role 是 Coordinator、Request 已经 `succeeded`，才写入唯一的 `adaptive_bootstrap`。没有 request、自然 EOF、provider error、空白模型结果、failed request 或重复 completion 都会 fail closed。模型事件进入 NDJSON 协议前会移除 `undefined`，usage 只保留标准 token 字段；provider 私有 metadata 不会穿过 child 边界。

用户可观察接口包括：

- 默认输出中 Task ID 恰好出现一次；`--format json` 的第一行一定是 `adaptive.task.created`，后续事件携带同一 Task ID。
- `adaptive status <task-id> --json` 从 SQLite 返回 Task、完整 ModelPolicy、durable bootstrap、最新 process identity/state 和 request lineage/usage；它不依赖创建 Task 的旧进程。
- `adaptive doctor --offline --json` 检查五张 foundation table、audit columns、child command、协议 round-trip 和工作区写权限，不调用 provider。
- `adaptive doctor --live --model provider/model --json` 复用同一个 Controller/Gateway 路径，执行一次隔离模型请求，再调用 `AdaptiveModelAudit.verify()`；只有单一 provider/model/policy hash 且 request 成功时才报告 `modelPolicyValid: true`。
- `adaptive export --doctor doctor.json --output evidence` 只接受与当前 SQLite 权威状态一致的 live doctor JSON，包括同一条 bootstrap。它输出真实 `doctor.json`、`model-requests.jsonl`、`process.json` 和覆盖前三个文件的 `SHA256SUMS`；输出目录已存在时拒绝覆盖，创建后任一写入失败会清理本次新建目录，避免半成品阻塞重试。

## 推荐代码阅读路线

1. 先读 `RunCommand` 的 `runtime` option 和 handler 顶部 Adaptive 分支，确认 baseline 分支的既有 Session 主体仍在原位置。
2. 再读 `AdaptiveController.start()`，按模型解析、Task、Agent、`prepare()` Manifest、RPC router 和 completion 顺序跟一遍主链。
3. 阅读 `runAdaptiveRole()`，确认 child 的业务逻辑只有一次 `model.stream` 和一次 `process.complete`，没有 provider/config 访问。
4. 阅读 `AdaptiveProcessSupervisor.StartInput.prepare` 及 `start()` 中 claim/prepare/accepted 的相对位置。
5. 阅读 `AdaptiveCommand` 中 `foundationChecks()`、`taskSummary()`、live doctor 和 export，理解运维命令如何只读 Store 或复用 Controller。
6. 最后阅读 `adaptive-process.test.ts`，观察测试如何通过真实 CLI subprocess、fake HTTP provider 和第二个 CLI 进程验证持久状态。

## 术语释义

**Runtime isolation** 的直觉是同一个 `opencode run` 明确选择两条执行道路。工程上，baseline 和 Adaptive 只共享稳定底层能力，不共享 Session 状态机；默认值固定为 baseline，Adaptive service 使用动态 import，避免无意改变旧路径的初始化和行为。

**Controller 与 Coordinator** 不是同一个角色。Controller 是确定性系统代码，负责校验、持久化、进程所有权和模型审计；Coordinator 是受模型驱动的独立 Agent 进程，将来负责 Roadmap 与调度。本任务中的 Coordinator 只有最小 bootstrap turn。

**Bootstrap Manifest** 是 Coordinator 第一次模型调用的权威输入清单，包含固定 system text、原始 requirement、工具空集、token 估算和 request hash。它不是聊天摘要；相同 Task generation 的 Gateway 只能读取 Store 中这份 Manifest。

**Durable first event** 表示 Task 已经写入 SQLite 后才输出 `adaptive.task.created`。即使后续 child 或 provider 失败，自动化仍能拿到真实 Task ID 查询失败事实，不会收到 `adt_unavailable` 之类的伪 ID。

**Create-new evidence** 表示 export 只创建此前不存在的目录和文件，并使用 exclusive write。这样一次验收证据不会被第二次命令静默覆盖；校验失败发生在创建目录之前。

**Model policy proof** 是 `AdaptiveModelAudit.verify()` 从 Task 和所有 Model Request 重新计算的事实：每个 request policy hash、resolved provider/model/variant、context limit 和 lineage 必须自洽，而且不能出现第二个模型身份。它比 doctor 自己打印 `true` 更强，因为 export 会再次对照 SQLite 验证。

## 测试看护逻辑

| 风险                                | 测试方法                                                | 关键断言                                                                | 证明范围                                                    |
| ----------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| baseline 被新 flag 改变             | 同一 fake provider 连续运行省略 runtime 与显式 baseline | stdout、stderr、exit code 相同                                          | baseline 默认选择和原 Session 输出保持一致                  |
| Adaptive 偷建 legacy Session        | 真实 Adaptive subprocess 完成后由新 CLI 查询 SQLite     | `session=0`、`adaptive_task=1`                                          | 两条 runtime 的 durable state 隔离                          |
| legacy 参数被静默忽略               | 对七种 Session/attach/interactive 参数逐一运行          | 每项返回专用 incompatibility，LLM calls 与 Task 数都为 0                | 拒绝发生在模型和持久化之前                                  |
| `--dir` 记录错误工作区              | 在 fixture 子目录运行 Adaptive，再查询 Task             | `adaptive_task.directory` 等于目标绝对路径                              | Task、child cwd 和 Location model resolution 使用同一目录   |
| Task ID 或 JSONL 顺序不稳定         | 分别运行 default 与 JSON format                         | default 仅一个 ID；JSON 第一条 created，全部事件同 ID                   | CLI 自动化可在模型调用前获得 durable identity               |
| child 没有真实调用模型              | fake HTTP provider 记录 request，并从新 CLI 读取 status | calls=1、Agent generation=1/stopped、Request succeeded、usage 一致      | source hidden child、Supervisor、Gateway 和 SQLite 完整串联 |
| completion 绕过成功审计             | provider 流不发 `finish` 便自然结束                     | CLI 非零退出、Request failed、无 bootstrap 记录                         | child 自述不能覆盖 Gateway/Store 事实                       |
| 空模型结果被当作有效 bootstrap       | provider 正常 `finish` 但不返回任何文本                  | CLI 非零退出、Request succeeded、无 bootstrap 记录                      | 模型调用成功不等于产生了可恢复的 Coordinator 状态           |
| bootstrap 只存在于旧进程内存        | 关闭第一套 Store layer 后从新 layer 读取                | output 与 Task/Agent/generation/Manifest/Request 全部一致               | Coordinator 第一条结果可用于后续恢复                        |
| provider 不返回 usage 时协议失败    | formatted test 的 fake response 刻意不带 usage          | bootstrap 仍成功、Request terminal                                      | `undefined` 不进入严格 JSON protocol，usage 不是成功前提    |
| 无效模型伪造成功                    | 请求不存在的 model                                      | 非零退出、无 `adt_unavailable`、明确 unavailable error                  | 解析失败不创建假结果                                        |
| claim 与 Manifest 错位              | Supervisor success/failure tests                        | `prepare` identity 等于 Handle/Store；失败时 generation terminal failed | Manifest 只能绑定已 claim 的真实 owner/generation           |
| offline doctor 意外访问 provider    | 不给 fake server response并检查 calls                   | 四项为 `ok`、protocol=1、calls=0                                        | 本地自检不依赖网络或 credential                             |
| live doctor 绕过 Gateway 或混用模型 | 执行真实 live doctor                                    | 单次 call、exact policy/process/request、`modelPolicyValid=true`        | live doctor 复用生产 Controller/Audit 路径                  |
| export 写空占位或覆盖证据           | 读取四个文件、重算 SHA256，再对非空和空目录重试         | 一条真实 request、真实 process、三条 checksum；重复导出失败             | G1 证据来自 Store 且 create-new                             |
| export 中途失败留下半成品           | 注入第二个文件写失败                                    | 返回失败并删除本次创建的 evidence 目录                                  | 重试不会被自己的残留目录阻塞                                |
| inline config 相对路径用错 cwd      | Location 与启动 cwd 分离并检查 Document provenance      | `source=OPENCODE_CONFIG_CONTENT`、`path` 为空                           | plugin/reference 消费者回退到 Location                      |
| 无效参数等待永不结束的 stdin        | 保持 stdin pipe 打开并传 `--session`                    | 两秒内返回 incompatibility                                              | compatibility gate 先于 stdin drain                         |
| Adaptive 静默丢弃附件               | 传 `--file`                                             | 明确 incompatibility、Task 和模型调用均为 0                             | 未实现附件 Manifest 前不伪装支持                            |
| Store 导出顺序不确定                | 同一 clock 下逆序插入 Agent/Request ID                  | 按 `time_created, id` 稳定返回且不混入其他 Task                         | status/export 在相同时间戳下仍可复现                        |

自动化使用的是 fake provider，因此不证明用户真实 credential、真实模型路由或 rate limit 可用；也不证明 packaged binary、Windows/macOS child argv 和发布目录正确。T10 会执行 packaged smoke，G1 最终由用户使用同一个真实模型完成 baseline 两次对照、live doctor 和 evidence export。

## 亲手验证

先从各自 package 运行本任务的 focused tests；不要从仓库根目录运行 test：

```bash
cd packages/core
bun test test/adaptive/store.test.ts test/catalog.test.ts test/config/config.test.ts
bun test test/database-migration.test.ts
bun typecheck

cd ../opencode
bun test test/adaptive/controller.test.ts test/adaptive/evidence.test.ts test/adaptive/process-supervisor.test.ts
bun test test/cli/adaptive-process.test.ts test/cli/run/run-process.test.ts
bun typecheck
```

预期观察：Core Store/Config/Catalog 测试全部通过；Adaptive subprocess 文件包含 offline doctor、runtime isolation、`--dir`、audited request、live doctor 和 export 用例；baseline runtime parity 用例通过；两个 package 的 typecheck 为 exit `0`。测试会自己启动本地 fake HTTP provider，不需要真实 API key。

可以重点单跑产品主链：

```bash
cd packages/opencode
bun test test/cli/adaptive-process.test.ts \
  --test-name-pattern "audited child model request|live doctor|export validates"
```

若 bootstrap 失败，先用返回的 Task ID 运行测试 fixture 内同等的 `adaptive status <task-id> --json`，检查 process state、exit reason 和 request status；若 provider calls 为 0，检查 inline Config/Catalog；若 request 已成功但 child exit 70，检查 canonical event 是否包含协议不接受的 `undefined`。

## 当前边界与下一步

T09 没有实现 Roadmap、Detail Pool、Context Assembler、worker coding tools、多 Agent 调度或上下文重建。它只建立这些能力将来必须经过的可靠入口：durable Task、独立进程、generation-bound Manifest、单模型 Gateway、durable bootstrap 和可导出审计。当前 Task 保持 `planning`；bootstrap 文本是 Coordinator 的第一条受控且可恢复结果，不是任务完成声明。

S01-T10 将构建实际 release binary，验证 compiled hidden-child argv 和 `adaptive doctor --offline`，再生成 G1 acceptance ledger。随后用户用真实短上下文模型执行两次 baseline、一次 live doctor 和一次 export；在用户把 G1 标成 `accepted` 之前不能进入 Stage 2。

Stage 2 才会把这里的单次 bootstrap 扩展为可重建 ContextManifest 和可重启 Agent。后续实现若让 child 读取 credential、直接选择 provider/model、从 Session transcript 恢复，或在 claim 前写 Manifest，都会破坏本任务建立的边界，必须由这些 subprocess、Supervisor 和 model-audit 测试继续阻止。
