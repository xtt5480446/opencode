# S01-T01：Adaptive Task 公共契约

## 先说结论

S01-T01 没有实现一个会运行的 Agent。它先为 Adaptive Runtime 建立一套唯一、可序列化、可在多个 package 之间传递的语言：什么是 Task、Agent process、model request、ContextManifest、ModelPolicy，以及它们有哪些合法状态。

这一步看起来像“定义类型”，实际解决的是分布式状态设计中的根问题：Controller、独立 Agent 进程、SQLite、CLI、HTTP API 和日志必须用同一种身份和字段语义交流。如果每层各自使用普通 `string` 和临时对象，后面即使上下文恢复做得再复杂，也无法确认恢复出来的是不是同一个 Task、同一代 Agent 或同一次模型请求。

合并记录：[PR #62 `feat(schema): add adaptive task contract`](https://github.com/xtt5480446/opencode/pull/62)

## 它在 G1 中的位置

S01-T01 是 G1 Execution Foundation 的根契约，没有前置 Task：

```text
S01-T01 AdaptiveTask contract
  ├─ S01-T02 computes ModelPolicy hash
  ├─ S01-T03 persists Task / Agent / Manifest / Request
  ├─ S01-T04 resolves an exact provider and model
  ├─ S01-T06 carries IDs through process RPC
  └─ S01-T09 exposes Task state through CLI
```

对最终研究目标的贡献是提供稳定的“指针”。短上下文 Agent 不应靠回忆一段长 transcript 来描述“我是谁、我在做什么、刚才哪次模型调用属于我”，而应携带短小且可验证的 `TaskID`、`AgentID`、`generation`、`ContextManifestID` 和 `RequestID`，再从权威存储加载需要的内容。

S01-T01 只定义其中四类 ID；`generation` 和权威存储从 S01-T03 开始实现。

## OpenCode baseline 原来提供了什么

### `@opencode-ai/schema` 是跨层契约包

OpenCode 已有 [`packages/schema`](../../../packages/schema) 存放 browser-safe 公共契约。这里的 browser-safe 不是指“在浏览器里展示”，而是指契约不能依赖 SQLite、Node.js 文件系统、provider client 或进程内状态，因此 Schema、Core、Server、Client 都能引用同一个定义。

依赖方向保持为：

```text
Schema
  ↑
Core / Protocol
  ↑
Server / Client composition
```

Adaptive Runtime 沿用这个边界，没有把 Task 类型放进 `packages/core`，也没有让 Schema 反向依赖运行时实现。

### OpenCode 已有的 Schema 范式

S01-T01 直接复用了这些 baseline primitive：

| Baseline primitive               | 位置                                                          | 在 S01-T01 中的用途                  |
| -------------------------------- | ------------------------------------------------------------- | ------------------------------------ |
| `ascending()`                    | [`identifier.ts`](../../../packages/schema/src/identifier.ts) | 生成 26 字符、有时间前缀的 ID suffix |
| `statics()`                      | [`schema.ts`](../../../packages/schema/src/schema.ts)         | 给 Schema 对象附加 `create()`        |
| `optional()`                     | [`schema.ts`](../../../packages/schema/src/schema.ts)         | 编码时真正省略 `undefined` 字段      |
| `PositiveInt` / `NonNegativeInt` | [`schema.ts`](../../../packages/schema/src/schema.ts)         | 约束预算、revision 和时间            |
| `Provider.ID`                    | [`provider.ts`](../../../packages/schema/src/provider.ts)     | 使用 OpenCode 已有 provider identity |
| `Model.ID` / `Model.VariantID`   | [`model.ts`](../../../packages/schema/src/model.ts)           | 使用已有 model identity 和 variant   |
| `AbsolutePath`                   | [`schema.ts`](../../../packages/schema/src/schema.ts)         | 与 OpenCode 其他模块共享路径类型     |

这是真正的代码复用，而不是仅模仿命名风格。

### 哪些 baseline 语义没有复用

OpenCode 已有 `Session`、内置 `Agent` 和 Task tool，但它们服务于现有 Session 执行路径。Adaptive Agent 的目标是可独立启动、拥有持久 generation、可以清空上下文后由另一个进程恢复，因此不能把 legacy Session ID 或内置 Agent name 重新解释为 Adaptive Agent identity。

S01-T01 新增的是平行契约，没有修改 baseline 的 Session、Message、Agent 或 Model 语义。

## 最终实现怎样组成

主要实现集中在 [`adaptive-task.ts`](../../../packages/schema/src/adaptive-task.ts)。文件很短，因为它只承担契约职责。

### 1. 四类不可混用的 ID

```ts
AdaptiveTask.ID // adt_ + 26 chars
AdaptiveTask.AgentID // ada_ + 26 chars
AdaptiveTask.RequestID // adr_ + 26 chars
AdaptiveTask.ContextManifestID // acm_ + 26 chars
```

共同 helper 同时做三件事：

```ts
Schema.String.annotate({ identifier: brand })
  .check(Schema.isPattern(new RegExp(`^${prefix}[0-9A-Za-z]{26}$`)))
  .pipe(
    Schema.brand(brand),
    statics((schema) => ({ create: () => schema.make(prefix + ascending()) })),
  )
```

- 正则表达式提供运行时格式校验；错误前缀、长度或字符会被拒绝。
- `Schema.brand` 让 TypeScript 区分底层同为 `string` 的不同 ID。
- `create()` 统一使用 OpenCode 的 `ascending()`，没有再造 UUID/ULID 实现。

前缀让日志、SQLite 和 RPC 报错中的身份一眼可辨；brand 则防止开发时把 `RequestID` 误传给需要 `AgentID` 的函数。

### 2. 三组 closed vocabulary

`Mode`：

```text
normal | benchmark
```

`benchmark` 后续允许系统在没有用户介入的情况下自主处理冲突，但必须执行同模型审计；S01-T01 只固定这个词汇，不实现行为。

`Role`：

```text
coordinator | roadmap-reviewer | discovery |
implementation | validator | integration
```

这里的 role 描述拟人化分工，不代表 OpenCode 当前已经能 spawn 这些独立进程。进程协议和 Supervisor 在后续 Task 实现。

`Status`：

```text
planning | running | needs_input | stopped |
cancelled | failed | completed | invalid
```

特别要区分：

- `stopped`：受控停止，未来可以恢复。
- `cancelled`：用户终止。
- `failed`：执行失败。
- `invalid`：模型混用或审计缺失等原因使评测结果无效。

`Schema.Literals` 只保证值属于闭集；哪些状态可以互相迁移，由 Store/Controller 实现，不在本文件里暗藏状态机。

### 3. `ModelPolicy`

```ts
{
  providerID,
  modelID,
  variant?,
  effectiveContextLimit,
  outputReserve,
  safetyReserve,
  hash,
}
```

三个预算的关系是：

```text
input working budget
  = effectiveContextLimit - outputReserve - safetyReserve
```

因此必须满足：

```text
outputReserve > 0
safetyReserve > 0
outputReserve + safetyReserve < effectiveContextLimit
```

这对短上下文优化很重要。我们不能把模型标称的 `256k` 全部分给输入，否则模型没有输出空间，也没有 tokenizer 偏差、provider 包装或边界误差的安全余量。

S01-T01 还要求 `hash` 形如：

```text
sha256:<64 lowercase hexadecimal chars>
```

但它只验证格式，不计算 hash，也不知道 hash 是否对应其他字段。内容计算和漂移检测是 S01-T02 的职责。

`variant` 使用 OpenCode 的 `optional()`。这不仅允许缺省值，还保证编码时不会产生 `{ variant: undefined }`，使跨进程 JSON 和后续 canonical hashing 只有一种表示。

### 4. `AdaptiveTask.Summary`

`Summary` 是面向 CLI/API/Store 的轻量公共视图：

```ts
{
  id,
  directory,
  mode,
  status,
  requirement,
  modelPolicy,
  roadmapRevision,
  timeCreated,
  timeUpdated,
}
```

`requirement` 保留用户原始需求；`roadmapRevision` 以后指向不断演进的全局 Roadmap 版本；时间和 revision 都要求非负整数。

这里需要准确理解 `AbsolutePath`：当前 OpenCode baseline 的实现是一个 branded string，并不会在 Schema 层检查路径是否真的绝对、存在或可访问。这些环境相关检查由 CLI/Controller 输入边界完成，S01-T01 的测试没有声称覆盖它们。

### 5. 一个 canonical export identity

文件首行：

```ts
export * as AdaptiveTask from "./adaptive-task"
```

Schema 根入口再导出这个 namespace：

```ts
export { AdaptiveTask } from "./adaptive-task"
```

所以这两种导入拿到的是同一组 Schema 对象：

```ts
import { AdaptiveTask } from "@opencode-ai/schema"
// Alternatively, the direct entrypoint exposes the same Schema objects:
import { AdaptiveTask as DirectAdaptiveTask } from "@opencode-ai/schema/adaptive-task"
```

这避免不同入口复制或包装 Schema 后产生不同 runtime identity，也让生成 API contract 时只有一个稳定的 `identifier`。

## 推荐代码阅读路线

1. 从 [`adaptive-task.ts`](../../../packages/schema/src/adaptive-task.ts) 通读最终契约，先看四类 ID，再看 vocabulary、ModelPolicy 和 Summary。
2. 打开 [`identifier.ts`](../../../packages/schema/src/identifier.ts)，理解 `ascending()` 如何提供固定长度 suffix，不需要深入随机数细节。
3. 阅读 [`schema.ts`](../../../packages/schema/src/schema.ts) 中的 `optional()`、`statics()` 和整数 Schema。
4. 对照 [`adaptive-task.test.ts`](../../../packages/schema/test/adaptive-task.test.ts)，观察每条不变量如何从自然语言变成可执行断言。
5. 最后看 [`contract-hygiene.test.ts`](../../../packages/schema/test/contract-hygiene.test.ts)，理解 package-wide contract 约束。

## 术语释义

### Schema 与 TypeScript type

TypeScript type 只在编译期存在，收到 JSON 后不会自动校验。Effect `Schema` 同时描述 TypeScript 类型以及运行时 decode/encode 规则，所以来自 CLI、SQLite、RPC 或 HTTP 的未知数据可以先验证再进入业务逻辑。

### Branded type

Brand 给基础类型增加编译期身份。`TaskID` 和 `AgentID` 在 JavaScript 运行时都是字符串，但 TypeScript 不再允许它们被随意互换。Brand 本身不提供安全边界，所以仍需正则 Schema 做运行时验证。

### Closed vocabulary

Closed vocabulary 表示合法词汇是有限集合。它比普通字符串更适合跨版本协议，因为拼写错误或未协商的新状态会立即失败，而不是悄悄进入未知分支。

### Canonical representation

Canonical 表示同一语义只有一种标准编码。S01-T01 对 ID 格式、optional variant 和 hash 外形建立 canonical 约束；ModelPolicy 内容的 canonical projection 在 S01-T02 才实现。

### Browser-safe contract

它表示该模块只包含跨环境的数据定义，不引用数据库、进程、文件系统实现或 provider credential。这样同一契约能安全地被 Core、Server 和 Client 使用。

## 测试看护逻辑

测试不是为了证明“这些字段能写出来”，而是看护后续模块会依赖的不变量。

| 风险                              | 对应测试                         | 实际证明                                       |
| --------------------------------- | -------------------------------- | ---------------------------------------------- |
| 不同身份被混用或日志难辨认        | exact ID prefix/length/charset   | 四类 ID 只接受各自 canonical 格式              |
| 新代码传入未协商状态              | mode/role/status closed-set test | 未知 vocabulary 在 decode 时失败               |
| 输入占满 context 导致无输出空间   | impossible budget test           | reserves 为正且总和严格小于 effective limit    |
| 同一 variant 出现两种 JSON        | optional variant round-trip      | `undefined` 编码时被省略                       |
| Roadmap revision 或时间不可排序   | Summary boundary test            | 只接受非负整数，不接受小数和无穷值             |
| root/direct import 演化成两份契约 | export identity test             | 两个入口引用同一 Schema object                 |
| 生成 contract 时 identifier 冲突  | contract hygiene test            | 公共 identifier 存在且唯一                     |
| 公共 Schema 退化为逃逸类型        | source hygiene test              | 当前源码不使用 `Schema.Any` 或 mutable wrapper |

这些测试没有证明：

- Task 已经能写入 SQLite；
- ModelPolicy hash 与字段内容一致；
- 状态迁移合法；
- Agent 已经是独立进程；
- Roadmap 或上下文恢复已经存在；
- `directory` 在文件系统中存在或可访问。

## 亲手验证

在仓库根目录执行：

```bash
cd packages/schema
bun test test/adaptive-task.test.ts test/contract-hygiene.test.ts
```

当前预期：

```text
14 pass
0 fail
55 expect() calls
```

再运行完整 package 和类型检查：

```bash
bun test
bun typecheck
```

PR #62 合并时的证据是：

- focused：`14/14`，`55` assertions；
- full Schema：`24/24`，`100` assertions；
- Schema typecheck：通过；
- repository pre-push typecheck：`30/30` tasks；
- 没有修改 baseline Session、Agent、Model、Runtime、Protocol 或数据库文件。

完整测试数量会随上游 OpenCode 继续演进，判断标准应是零失败，而不是永久锁定历史数字。

## 当前边界与下一步

S01-T01 交付的是公共语言，不是执行系统：

```text
contract exists
≠ durable state exists
≠ process recovery exists
≠ model call is audited
```

紧接着：

- S01-T02 为完整 ModelPolicy 计算确定性 identity，并检测字段漂移。
- S01-T03 把这些契约落入 SQLite，加入 Agent generation/lease。
- S01-T05/S01-T08 在真正模型调用前后使用 RequestID、ManifestID 和 policy identity 做审计。

设计背景可继续阅读 [S01-T01 design spec](../../superpowers/specs/2026-07-17-s01-t01-adaptive-task-contract-design.md)，但最终行为以本教程链接的合并代码和测试为准。
