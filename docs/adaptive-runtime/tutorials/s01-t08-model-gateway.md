# S01-T08：带审计的模型网关

## 先说结论

S01-T08 新增了 `AdaptiveModelGateway`：Adaptive Agent 只能提交 Task、Agent generation、Manifest 与 Request 的 durable ID，网关再从 Store 读取冻结的 `ModelPolicy` 和完整 `ContextManifest`，通过 OpenCode 现有模型解析与 credential 路径发起一次 `LLMClient.stream`。请求从 `admitted` 进入 `streaming`，最后无论成功、provider 失败还是调用方中断，都会在不可中断 finalizer 中落到 `succeeded|failed|interrupted`。

本任务没有实现 Controller bootstrap、child RPC router、tool execution、自动 continuation 或多轮 Agent loop。它只建立“一次可信模型调用”的唯一执行边界；S01-T09 才把 Controller 与 child 的 `model.stream` 请求接到这个边界。

## 它在当前 Milestone 中的位置

前面的任务已经分别提供 durable policy、精确模型解析、请求审计和 credential-free 进程。S01-T08 把这些能力组合成一条真实可执行、可审计且不信任 child payload 的模型路径。

```text
S01-T03 Store + S01-T04 resolveRef + S01-T05 ModelAudit + S01-T07 process isolation
  → S01-T08 audited one-turn Model Gateway
  → S01-T09 Controller / child RPC routing
  → S01-T10 packaged G1 evidence
```

这对短上下文架构很关键：Worker 重启时不需要把 provider、model、system prompt 和历史文本继续留在自身上下文里。它只持有 durable IDs；真正的模型身份与局部上下文由 Controller 侧网关按当前 Roadmap/Manifest 状态重新装配，因此上下文重建不会依赖旧 transcript 的偶然记忆。

## OpenCode baseline 与复用边界

OpenCode 已有两段成熟能力被直接复用。

第一段是 Location-scoped 模型解析：

```text
SessionRunnerModel.resolveRef({ providerID, modelID, variant })
  → Location Catalog exact lookup
  → Integration active connection / credential resolution
  → variant overlay
  → native LLM.Model route
```

`AdaptiveModelGateway` 没有建立第二套 provider registry，也不读取 child environment 中的 key。它在 Task 的 directory 对应的共享 `LocationServiceMap` 内调用 `SessionRunnerModel.resolveRef`，继续使用现有 Catalog、Integration、credential 和 protocol route。

第二段是 canonical LLM transport：网关使用 `LLM.request` 构造请求，再调用一次 `LLMClient.Service.stream`。返回的 `LLMEvent` 不做重新编码或私有事件转换，所以上层仍消费 OpenCode/Core 已有的统一事件协议。

Adaptive 新增的是 trust boundary 和 durable audit ordering。Baseline Session loop 会从当前 Session 状态组装请求、执行工具并决定 continuation；本任务不能复用这些语义，因为 Adaptive 的上下文必须来自指定 Manifest，而且 tool/continuation 分别属于后续调度层。网关因此只做一个 provider turn，不调用 `SessionPrompt.loop`、`SessionRunner` tool settlement 或 compaction。

## 最终实现

公开输入只有可信引用所需的六个字段：

```ts
interface StreamInput {
  taskID: AdaptiveTask.ID
  agentID: AdaptiveTask.AgentID
  generation: number
  manifestID: AdaptiveTask.ContextManifestID
  requestID: AdaptiveTask.RequestID
  retryOf?: AdaptiveTask.RequestID
}
```

不存在 provider、model、system、messages、tools 或任意 prompt text 字段。即使 JavaScript 调用方在对象上附加这些额外属性，网关也不会读取它们。

一次调用按固定顺序执行：

```text
StreamInput IDs
  → AdaptiveStore.getTask() loads immutable ModelPolicy
  → AdaptiveModelAudit.admit() validates Task / Agent / generation / Manifest / retry lineage
  → Task directory LocationServiceMap
  → SessionRunnerModel.resolveRef(pinned logical model ref)
  → provider and effective context-budget checks
  → AdaptiveStore.getManifest() + canonical Message/ToolDefinition decode
  → one LLM.request(maxTokens = outputReserve)
  → audit.streaming()
  → one LLMClient.stream()
  → uninterruptible succeeded / failed / interrupted settlement
```

### Logical model ID 与 provider wire model ID

这里有一个容易误解但必须保留的区别。`ModelPolicy.modelID` 是 Catalog 中的 logical model ID，例如 `kimi-catalog`；`SessionRunnerModel.resolveRef` 返回的 `LLM.Model.id` 可以是 provider API 实际发送的 wire ID，例如 `kimi-wire-api`。二者不要求字符串相等。

模型一致性由两层证明：网关只把冻结的 logical `providerID/modelID/variant` 传给 exact `resolveRef`，resolver 负责选择对应 Catalog record 和 variant；真正发给 provider 的 request 使用 resolver 返回的 wire ID。审计 settlement 继续记录 logical ID 和 policy hash，避免把 provider API alias 错当成一次模型漂移。网关额外校验 resolver 返回的 provider 必须与 policy 一致。

### Context limit 与 Manifest budget

有效上限取 route limit 和 pinned policy limit 的较小值：

```ts
effectiveContextLimit = Math.min(routeContextLimit, policy.effectiveContextLimit)
```

因此 provider 当前 route 可以比 policy 更小，但一次请求永远不会以高于 policy 的上限记账。若 route 没有正整数 limit、limit 连 `outputReserve + safetyReserve` 都无法容纳，或 Manifest 估算加 reserves 超出有效预算，网关在 `LLMClient` 调用前返回 typed `RoutePolicyMismatchError`。已经插入的 audit row 仍由 finalizer 结算为 terminal `failed`，不会残留 `admitted|streaming`。

### Admission ownership 与 terminal settlement

Task policy 在 admission 前以普通 interruptible Effect 读取；Task 不存在或 policy 损坏时，网关尚未拥有 Request，不注册 finalizer。真正的 ownership handoff 使用 `Effect.uninterruptibleMask` 把两件事合成一个不可分割区间：`AdaptiveModelAudit.admit()` 成功插入 row，紧接着向当前 stream Scope 注册 terminal finalizer。只有 finalizer 安装完成后才恢复正常 interruption。这样即使取消信号恰好到达数据库 commit 与下一步 prepare 之间，也会先完成 handoff，再由 finalizer 把 row 结算为 `interrupted`。

### 错误脱敏

`RequestState` 只保存结算需要的少量事实：policy、resolved provider、effective limit、最新的 input/output token counters、provider 是否开始以及是否收到 `provider-error`。不同 usage event 可以分别提供 input 或 output，网关会保留每个字段最近一次有效的非负整数值，不会因后续事件省略另一个字段而清空已观测计数。

Scope finalizer 根据 stream exit 决定 terminal status：正常结束为 `succeeded`，canonical `provider-error` event 为 `failed`，fiber interruption 为 `interrupted`，transport failure 为 `failed`。数据库只保存固定的脱敏摘要。

credential-free 调用方不会收到可能带 provider 或 credential 细节的底层 cause。resolver/location 的 typed failure、`Integration.AuthorizationError.cause` 和 defect 统一映射成只含 `requestID + "Model resolution failed"` 的 `ModelResolutionError`；Manifest load corruption 与 Message/Tool decode failure 统一映射成只含 IDs 和固定 reason 的 `InvalidManifestContentError`。transport 的原始 `LLMError` 同样转换成不带 cause/message 的 `ProviderStreamError`。最终 settlement 自身若异常，只记录 request ID 和固定日志，不把 defect carrier 暴露到 public Gateway error；canonical provider events 则仍原样转发。

Retry 不在网关内自动执行。调用方显式提交新的 `requestID` 和旧的 `retryOf`，`AdaptiveModelAudit.admit` 验证 Task、Agent 与 policy lineage，两个 provider turn 仍分别只有一次 `LLMClient.stream`。

## 推荐代码阅读路线

1. 先读 [`StreamInput` 与 `Interface`](../../../packages/opencode/src/adaptive/model-gateway.ts)，确认 child 能提交什么，以及哪些模型/上下文字段根本不存在于公开 API。
2. 再读同文件的 `prepare()`，按 `getTask → admit → resolveRef → Manifest decode → streaming` 理解可信数据怎样进入一次 provider request。
3. 阅读 `RequestState`、`updateUsage()` 与 `settlement()`，理解成功、provider event、transport failure 和 interruption 怎样统一落库。
4. 阅读 [`AppLayer`](../../../packages/opencode/src/effect/app-runtime.ts)，确认 Store、Audit、Gateway 和 ProcessSupervisor 使用 `AppNodeBuilderV1` 组合，并共享 builder 提供的同一个 `LocationServiceMap`。
5. 最后读 [`model-gateway.test.ts`](../../../packages/opencode/test/adaptive/model-gateway.test.ts)，观察 fake resolver 与 fake LLM stream 怎样检查真实 request、stream interruption 和数据库 terminal row。

## 术语释义

### Model Gateway

直觉上，它是所有 Adaptive Agent 访问模型时必须经过的“门”。工程上，它同时拥有模型解析、请求构造、provider stream 和 audit settlement 的唯一调用权；本项目中 Worker 不持有 credential，也不能自行选择 provider 或 prompt。

### Trust boundary

Trust boundary 表示边界两侧的数据可信等级不同。child RPC payload 属于不可信输入，只能携带 durable IDs；Store 中的 Task policy 和 Manifest 才是权威状态。网关不会用 payload 中附加的 provider/model/text 覆盖 Store 内容。

### Canonical LLMEvent

Canonical event 是 `@opencode-ai/llm` 对不同 provider 流事件的统一表示，例如 `text-delta`、`step-finish`、`finish` 和 `provider-error`。网关转发相同对象，不创建 Adaptive 私有 token-stream 协议。

### Uninterruptible finalizer

Finalizer 是 stream scope 结束时必定执行的清理/结算逻辑。Uninterruptible 表示调用方取消 fiber 时，provider 读取可以停止，但 terminal audit update 不能在中途再次被取消。本任务用它保证已 admitted 的 Request 最终可审计。

### Retry lineage

Retry lineage 是新 Request 对失败父 Request 的显式引用。它不是“同一个请求在内存里再跑一次”；每次尝试都有独立 `requestID`、状态、usage 和 completion time，同时共享同一 policy identity。

## 测试看护逻辑

| 风险                                              | 测试方法                                                                | 关键断言                                                                                          | 证明范围                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| child 注入 provider/model/text                    | `uses only stored model identity and Manifest context`                  | fake request 只含 stored system/messages/tools；resolver 收到 pinned ref                          | 不可信 extra payload 不进入 provider request                 |
| logical ID 与 wire ID 被错误混为一谈              | 同一测试                                                                | resolver 输入 `kimi-catalog`，provider request 使用 `kimi-wire-api`，audit 仍记录 logical ID/hash | exact catalog identity 与 wire route identity 都被保留       |
| stale Worker 越权调用                             | `rejects a stale generation`                                            | typed stale error；resolver 与 LLM 调用均为 0                                                     | admission 在 provider 前执行                                 |
| caller 中断留下 running row 或丢失 partial usage  | `settles interruption with the latest partial usage`                    | `interrupted`、input/output 分段计数、`timeCompleted`                                             | stream cancellation 仍完成 terminal settlement               |
| transport 错误把 credential 泄露给 child 或数据库 | `keeps exact retry lineage after a failed provider stream`              | caller 只见 generic typed error；stored failure 不含 secret                                       | provider transport failure 被双重脱敏                        |
| retry 偷换 policy/model                           | 同一测试                                                                | `retryOf` 精确；两条 policy hash、resolver ref 和 provider request identity 相同                  | retry 保持单一模型 lineage                                   |
| canonical provider error 被误判成功               | `settles a provider-error event`                                        | event 对象原样返回；row 为 redacted `failed`                                                      | event forwarding 与 audit status 同时正确                    |
| resolver/provider 或 route budget 漂移            | 两个 `fails closed` 测试                                                | 0 LLM calls；row terminal failed；actual observation 可审计                                       | mismatch 不会到达 provider，也不留 unfinished row            |
| resolver/auth defect 泄露 credential              | 两个 `maps resolver` 测试                                               | defect 与 `Integration.AuthorizationError.cause` 都变成 fixed `ModelResolutionError`              | child 与 audit summary 都看不到 resolver secret              |
| malformed/corrupt Manifest 泄露上下文             | 两个 `maps ... Manifest` 测试                                           | fixed `InvalidManifestContentError`、0 LLM calls、terminal failed                                 | load/parse diagnostics 不穿过 credential-free boundary       |
| admit commit 后立刻中断留下 unfinished row        | `settles after admission when interrupted during the ownership handoff` | wrapped real Audit 在 admit 返回处阻塞；取消后 row 为 `interrupted` 且有 completion time          | admission 与 finalizer registration 是原子 ownership handoff |

这些自动化测试使用 fake model resolver 和 fake LLM stream，不访问真实 provider，也不证明用户 credential 当前有效、packaged child 能发起 RPC、Controller 能正确分配 Manifest，或 G1 benchmark 结果已经有效。真实 CLI/router 由 S01-T09 接入，packaged/live evidence 由 S01-T10 和用户 gate 完成。

## 亲手验证

先从 OpenCode package 运行网关 focused tests：

```bash
cd packages/opencode
bun test test/adaptive/model-gateway.test.ts
```

预期观察：所有 `AdaptiveModelGateway` cases 通过；测试不会访问外网。失败时先看 fake request assertion、Request terminal row，或 typed error tag，而不是只看最终 event 数量。

再运行网关与已有 process 协议/监督回归及 package typecheck：

```bash
cd packages/opencode
bun test test/adaptive/model-gateway.test.ts test/adaptive/process-supervisor.test.ts test/adaptive/process-protocol.test.ts
bun typecheck
```

最后验证被复用的 Core audit 与 resolver：

```bash
cd packages/core
bun test test/adaptive/model-audit.test.ts test/session-runner-model.test.ts
bun typecheck
```

预期均以退出码 `0` 完成。测试汇总数字以当前命令输出为准；教程不把历史 PR 的单次计数当成永久验收条件。

## 当前边界与下一步

S01-T08 没有决定何时创建 Task、哪个 Agent 首先请求模型、child RPC method 怎样映射成 `StreamInput`、模型输出怎样写回 bootstrap 结果，也没有执行 Manifest 中公布的 tools。网关只负责一次 durable、audited provider turn。

S01-T09 会实现 Controller bootstrap 和 CLI runtime isolation，把 credential-free child 的模型请求绑定到 supervisor 已验证的 Task/Agent/generation，再调用本服务。S01-T10 会验证 packaged child、真实 model route 与 G1 evidence。若后续代码绕过 `AdaptiveModelGateway` 直接调用 `LLMClient`，或者忽略 terminal audit result，benchmark 的模型一致性证明将失效并必须标记为 invalid。
