# S01-T01 Adaptive Task 公共契约设计

## 1. 目标与边界

S01-T01 在 `@opencode-ai/schema` 中定义 Adaptive Runtime 的最小公共 Task 契约。它为后续 Core 持久化、进程协议、Model Gateway、CLI、HTTP API 和 SDK 提供唯一的类型身份与序列化格式，但不实现 hash 计算、状态迁移、数据库、模型解析、模型调用或 Agent 进程。

本任务遵循两个约束：

1. 复用 OpenCode 已有且适合当前架构的 canonical Schema、ID 生成器、optional 编码和 namespace 投影模式。
2. 不复用 legacy Session/TaskTool 的控制循环、上下文时间线或 subagent 语义；Adaptive Agent 始终表示可独立恢复的进程身份。

## 2. 在 G1 中的角色

S01-T01 没有前置依赖，是 G1 的根契约。直接消费者包括：

- S01-T02：根据 `ModelPolicy` 的执行字段计算 canonical hash。
- S01-T03：持久化 Task、Agent process、ContextManifest 和 model request。
- S01-T04：把请求模型解析为 `ModelPolicy` 中的 canonical provider/model identity。
- S01-T06：在 Controller 与 Agent 进程协议中携带 Task、Agent、Manifest 和 Request ID。

S01-T05、S01-T07、S01-T08、S01-T09 和 S01-T10 通过上述模块间接依赖本契约。公共语义一旦发布，后续任务不得创建平行类型或重新解释字段。

## 3. 复用的 OpenCode 设计

- 使用 `packages/schema/src/identifier.ts` 的 `ascending()` 生成 26 位字母数字后缀。
- 使用 `packages/schema/src/schema.ts` 的 `statics(...)` 暴露 `create()`，使用 `optional(...)` 保证编码时省略 `undefined`。
- 使用现有 `Provider.ID`、`Model.ID` 和 `Model.VariantID`，不创建普通字符串替代品。
- 使用现有 `AbsolutePath` 表示 Task 工作目录。
- 模块采用 `export * as AdaptiveTask from "./adaptive-task"` 的 namespace 投影，并从 Schema 根入口导出同一个 canonical schema identity。
- 公共 Schema 使用稳定、唯一的 domain-qualified identifier，并保持 readonly、JSON 可序列化和 browser-safe。

## 4. 公共契约

### 4.1 标识符

| 类型                             | 前缀   | 含义                                  |
| -------------------------------- | ------ | ------------------------------------- |
| `AdaptiveTask.ID`                | `adt_` | 一个完整 Adaptive 开发任务            |
| `AdaptiveTask.AgentID`           | `ada_` | 一个可独立启动和恢复的 Agent 身份     |
| `AdaptiveTask.RequestID`         | `adr_` | 一次受审计模型请求                    |
| `AdaptiveTask.ContextManifestID` | `acm_` | 一次 provider turn 的确定性上下文清单 |

解码必须匹配完整 canonical 格式：固定前缀加 26 位 ASCII 字母数字后缀。仅前缀正确、长度错误或包含其他字符的值必须被拒绝。

### 4.2 闭集枚举

- `Mode`：`normal | benchmark`
- `Role`：`coordinator | roadmap-reviewer | discovery | implementation | validator | integration`
- `Status`：`planning | running | needs_input | stopped | cancelled | failed | completed | invalid`

`stopped` 表示受控停止、允许后续恢复；`cancelled` 是用户终止的 terminal 状态；`failed` 是执行失败；`invalid` 表示模型混用、审计缺失等导致结果不得计入评测。S01-T01 只固化词汇，合法状态迁移由后续 Store/Controller 负责。

### 4.3 ModelPolicy

`ModelPolicy` 包含：

- canonical `providerID`、`modelID` 和可选 `variant`；
- `effectiveContextLimit`；
- `outputReserve`；
- `safetyReserve`；
- `hash`。

契约必须拒绝以下输入：

- 任一预算不是正整数；
- `outputReserve + safetyReserve >= effectiveContextLimit`；
- hash 不是 `sha256:` 加 64 位小写十六进制；
- provider/model/variant 不符合 OpenCode canonical ID schema。

`ModelPolicy` 不包含 provider credential、prompt、消息历史、工具结果或可变运行配置。S01-T02 负责生成 hash，S01-T03 负责持久化不可变性，S01-T05/S01-T08 负责在模型请求前验证它。

### 4.4 Task Summary

`Summary` 包含 Task ID、绝对工作目录、模式、状态、原始需求、ModelPolicy、Roadmap revision 和创建/更新时间。

- `roadmapRevision` 是非负整数；G1 创建 Task 时为 `0`。
- 时间必须是非负整数毫秒值，不能接受负数、小数、`NaN` 或无穷值。
- `requirement` 保留用户原始需求；是否允许空需求由 CLI/Controller 输入边界决定，本契约不擅自改写文本。

## 5. 调用和数据流

```text
CLI input
  -> AdaptiveController resolves workspace and requested model
  -> S01-T02 creates the immutable ModelPolicy
  -> S01-T03 stores AdaptiveTask.Summary
  -> S01-T06 starts an Agent using TaskID + AgentID + Role
  -> S01-T08 handles a model turn using RequestID + ContextManifestID
  -> status/API/export return the same canonical Task contract
```

Schema 包不依赖或调用上述模块；依赖方向始终从 Core/Protocol/Runtime 指向 Schema。

## 6. 测试与验收

采用 TDD，先观察 `adaptive-task` 模块不存在的失败，再实现契约。至少覆盖：

- 四类 ID 的生成前缀、长度、字符集和非法值拒绝；
- namespace/root/direct-entrypoint 引用同一个 schema identity；
- optional `variant` 编码时不产生 `undefined` 字段；
- Mode、Role、Status 对未知值的拒绝；
- canonical provider/model/variant 类型；
- ModelPolicy 预算不变量和严格 hash 格式；
- AbsolutePath、非负 revision、非负整数时间值；
- 公共 Schema identifier 稳定且不重复；
- `packages/schema` focused test、完整 test 和 `bun typecheck` 通过。

S01-T01 没有可单独手工运行的产品流程。它的验收证据是契约测试、完整 Schema 回归和下游编译边界；G1 的真实 CLI、进程和模型调用在 S01-T09/S01-T10 由用户运行验收。

## 7. 明确不做

- 不实现 ModelPolicy canonical serialization 或 hash 计算。
- 不实现数据库表、状态迁移或不可变写入检查。
- 不实现 Roadmap、Detail、Assignment 或 Checkpoint。
- 不实现模型解析、模型调用、Agent 进程或 CLI。
- 不修改 baseline Session、Message、Agent 或 Model 契约语义。
