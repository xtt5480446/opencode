# S01-T04：固定模型引用的直接解析

## 先说结论

S01-T04 为现有 `SessionRunnerModel` 服务增加了 `resolveRef({ model })`。调用方现在可以提交一份不可变的 `ModelV2.Ref`，其中明确包含 `providerID`、模型 `id` 和可选 `variant`，并得到已经绑定 native route、认证、请求默认值与 token limits 的 `LLM.Model`。这让后续 Adaptive Runtime 不必伪造一条 Session，只为解析已经冻结在 ModelPolicy 中的模型引用。

本任务没有新增 Adaptive 专用 provider registry，也没有绕过 OpenCode 的 catalog、integration credential 或协议 route。它同样没有发起真实模型请求、写入 request audit，或决定 Task 应选择哪个模型；这些职责仍由上游策略和后续请求准入任务承担。

## 它在当前 Milestone 中的位置

S01-T01 与 S01-T02 定义了 ModelPolicy 的类型和稳定 hash，S01-T03 又把完整 policy 持久化为可重启 Task 的权威状态。S01-T04 负责把 policy 中已经钉住的 provider/model/variant 引用接回 OpenCode 的真实模型运行路径，是“策略身份”与“可执行 route”之间的窄桥梁。

```text
S01-T03 durable Task and ModelPolicy
  → S01-T04 exact provider / model / variant resolution
  → S01-T05 audited model-request admission
  → S01-T08 same-model benchmark comparison
```

短上下文 Agent 在重启后只需从 Store 取回冻结引用，再通过当前 Location 的 `SessionRunnerModel` 解析；它不需要依赖旧 transcript 记住上次用了哪个 provider。后续 S01-T05 可以在请求准入和审计记录中绑定同一份 policy，而不是让每个消费者各写一套模型发现逻辑。

## OpenCode baseline 与复用边界

修改前，真实入口只有 `SessionRunnerModel.Interface.resolve(session)`。当 Session 明确携带 `session.model` 时，location layer 会在 `Catalog.Service.model.available()` 中按 `providerID + id` 精确查找；没有明确模型时，它先检查 catalog default，再退回第一个受支持模型。选中模型后，代码读取 provider 的 `integrationID`，解析 active connection，叠加 variant，最后由 `fromCatalogModel()` 转换为 OpenAI Responses、Anthropic Messages 或 OpenAI-compatible Chat route。

```text
SessionRunnerModel.resolve(session)
  → Catalog.model.default() or Catalog.model.available()
  → Catalog.provider.get(providerID)
  → Integration.connection.active() / resolve()
  → withVariant()
  → fromCatalogModel()
  → native LLM.Model
```

S01-T04 直接复用了这条 baseline。`Catalog` 继续负责 Location 插件合并、provider/model 可用性过滤，以及 provider defaults 向 model 的投影；`Integration` 继续负责 credential connection；`withVariant()` 继续做 headers/body overlay；`fromCatalogModel()` 继续负责认证、endpoint、limits 和协议 route 转换。新代码没有创建 Adaptive provider resolver，也没有复制认证分支。

复用边界同样明确：`resolveRef` 只解析已经选定的引用，不运行 default selection，也不检查 Adaptive ModelPolicy hash。policy 完整性属于 `AdaptiveModelPolicy` 与 `AdaptiveStore`，catalog 可用性和 route 构造属于 `SessionRunnerModel`；把二者保持分离，可以避免 Adaptive 语义污染普通 Session 路径。

## 最终实现

公开输入被刻意保持很小：

```ts
export type RefInput = { readonly model: ModelV2.Ref }

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
  readonly resolveRef: (input: RefInput) => Effect.Effect<Model, Error>
}
```

`locationLayer` 内部新增一个私有 `resolveExact(ref, catalogModel?)`。直接引用与显式 Session 模型都不做模糊匹配：它们从 available catalog 中寻找 provider 和 model ID 同时相等的记录。找不到时继续返回原有 `ModelUnavailableError`，字段仍是请求中的 `providerID` 与 `modelID`。

找到模型后，`resolveExact` 只沿 baseline 顺序执行一次 provider connection、credential resolve、variant overlay 和 route conversion。variant 不存在时仍由 `withVariant()` 返回 `VariantUnavailableError`；API 没有 native route 时仍返回 `UnsupportedApiError`；integration 授权失败也保留原有 typed error。

```text
RefInput { providerID, id, variant }
  → exact match in Catalog.model.available()
  → provider integration and active credential
  → variant headers/body overlay
  → native protocol route + endpoint + limits
  → prepared provider request
```

`resolve(session)` 的分支语义没有变化。若 `session.model` 存在，它立即委托给同一个 `resolveExact`；若模型缺省，它仍按原顺序读取 catalog default、检查 `supported()`、再寻找第一个受支持模型。缺省分支完全没有候选时，仍以该 Session 的 `sessionID` 构造 `ModelNotSelectedError`。已经选出的 default model 直接交给 helper，避免重复 provider 逻辑，也避免第二次 catalog lookup 改变选择结果。

`resolveRef({ model })` 则始终走精确解析，不会进入 default selection，因此不会产生 `ModelNotSelectedError`。这项区分很重要：Adaptive policy 已经声明了目标，目标不可用应报告“指定模型不可用”，而不是静默换成另一个模型。

## 推荐代码阅读路线

1. 先读 [`ModelV2.Ref`](../../../packages/core/src/model.ts)，确认 direct input 只携带 provider、model 与 variant 身份，不包含 endpoint 或 secret。
2. 再读 [`RefInput` 与 `Interface`](../../../packages/core/src/session/runner/model.ts)，理解新入口如何扩展现有 Location-scoped service，而不是新增平行服务。
3. 顺序阅读同文件的 `withVariant()`、`fromCatalogModel()` 和 `supported()`，分别理解 variant overlay、native route conversion 与 default fallback 的边界。
4. 阅读 `locationLayer` 内的 `resolveExact()`、`resolve(session)` 与 `resolveRef()`，重点比较显式引用和缺省 Session 两条控制流。
5. 最后读 [`resolves an immutable model reference`](../../../packages/core/test/session-runner-model.test.ts) 测试，观察真实 catalog、prepared request、route provider/model/limits 和 variant overlay 怎样一起被断言。

## 术语释义

### Immutable model reference

直觉上，它是一张不会在解析过程中被改写的“模型坐标”。工程上，`ModelV2.Ref` 用 readonly 字段保存 `providerID`、`id` 和可选 `variant`；本项目中它来自冻结 ModelPolicy，resolver 只读取坐标并返回新的 route model，不把 catalog defaults 回写到引用里。

### Exact resolution

Exact resolution 表示 provider ID 和 model ID 必须同时匹配 available catalog 记录。它不同于 default selection、family alias 或“找一个相似模型”。本任务中显式 Session model 与 `resolveRef` 共享这一规则，因此不可用的固定引用会得到 typed error，而不会降级到其他 provider。

### Location-scoped catalog

Location 是 OpenCode 对当前目录及其配置、插件和 credential 环境的运行边界。Catalog 并非全局静态模型表；它会被该 Location 的插件填充和过滤。S01-T04 在原有 location layer 内解析，所以同一引用在不同目录中可以因配置或授权不同而表现为可用或不可用。

### Variant overlay

Variant 是同一模型上的请求参数预设，例如 reasoning effort。Overlay 表示把 variant 的 headers/body 合并到 catalog model 的请求默认值中，同时不修改原 catalog record。这里继续使用 Immer 生成解析后的模型副本，显式未知 variant 返回 `VariantUnavailableError`。

### Native route conversion

Catalog model 描述 provider API 与默认请求，而 native route 是 `@opencode-ai/llm` 真正用来编译请求的协议对象。`fromCatalogModel()` 把前者转换为 Responses、Messages 或 compatible Chat route，并绑定 auth、base URL、headers、HTTP defaults 与 context/output limits。

## 测试看护逻辑

| 风险 | 测试方法 | 关键断言 | 证明范围 |
| ---- | -------- | -------- | -------- |
| direct ref 偷走 default selection | `resolves an immutable model reference` | 指定 provider/model 精确出现在 prepared model | 新入口使用固定引用 |
| direct path 丢失 route limits | 同一 focused test | `context: 100`、`output: 20` 位于 route defaults | catalog limits 被 route 保留 |
| variant 在新入口被忽略 | 同一 focused test | resolved route body 含 high reasoning overlay | direct ref 复用 variant 逻辑 |
| route conversion 与请求编译断开 | 同一 focused test | `LLMClient.prepare()` 产出 `openai-responses` | 返回值可进入真实编译器 |
| 显式未知 variant 被静默接受 | 既有 unavailable variant test | `VariantUnavailableError` 字段与 message 不变 | 原错误语义继续有效 |
| Session 路径发生回归 | `session-runner-model.test.ts` 与 `session-runner.test.ts` | 既有 model mapping、auth、runner turn 全部通过 | 普通 Session 仍可工作 |

这些测试没有证明真实 provider 网络可达、credential 仍有效、Adaptive ModelPolicy hash 正确、请求已经持久审计，或两个 benchmark request 确实使用同一模型。它们只证明解析和请求编译边界保持一致；网络执行、审计准入与 benchmark orchestration 由后续任务验证。

## 亲手验证

从 Core package 运行 focused RED/GREEN 回归测试：

```bash
cd packages/core
bun test test/session-runner-model.test.ts --test-name-pattern "resolves an immutable model reference"
```

预期观察：测试名显示 `pass`，汇总为 `1 pass`、`0 fail`。若出现 `ModelUnavailableError`，先检查测试 catalog 中的 provider/model ID 与传入 ref 是否完全相等；若出现 `VariantUnavailableError`，检查 variant 是否存在于同一 catalog model。

再运行任务要求的完整回归与类型检查：

```bash
cd packages/core
bun test test/session-runner-model.test.ts test/session-runner.test.ts
bun typecheck
```

预期观察：两个 test 文件退出码为 `0`，没有 Session runner 回归；`tsgo --noEmit` 同样退出 `0`。测试会准备 provider request，但不会访问外部模型 API，也不需要真实 key。

## 当前边界与下一步

S01-T04 只接受 `ModelV2.Ref` 并解析当前 Location 中的可执行模型。它不从 Task ID 自动读取 policy，不验证 policy hash，不持久化 Request/Manifest 关联，不执行 retry，也不在目标不可用时替换模型。调用方必须先取得并验证权威 ModelPolicy，再明确处理 typed resolution error。

S01-T05 将接手 audited model-request admission，把一次请求绑定到 Task、Agent generation、ContextManifest 与 ModelPolicy snapshot；S01-T08 才会在 benchmark 流程中强制候选结果使用同一模型。若本任务的 exact resolution 失效，下游即使保存了正确 policy hash，也可能把不同 provider 或 variant 的结果错误地当成可比较证据，因此后续消费者必须统一调用本服务，不能重新实现 provider lookup。
