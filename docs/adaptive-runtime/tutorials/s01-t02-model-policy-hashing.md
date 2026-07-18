# S01-T02：ModelPolicy 确定性 Hash

## 先说结论

S01-T02 把 S01-T01 定义的 `ModelPolicy` 从“一组经过校验的字段”提升为“具有确定性内容身份的执行策略”。相同策略无论由哪个进程、以什么对象 key 顺序构造，都会产生相同 hash；任何影响执行的字段发生变化，hash 都会变化。

它还提供 `assertEqual()`：不盲信对象里已有的 hash，而是重新计算 expected 和 actual 两边，再比较字段内容。因此旧 hash 被挪用、hash 被单独修改，甚至两个对象被改成同一个伪造 hash，都会被拒绝。

合并记录：[PR #63 `feat(core): pin adaptive model policy`](https://github.com/xtt5480446/opencode/pull/63)

## 为什么有类型还需要 hash

Effect Schema 能回答：

```text
“这个对象的字段和预算关系是否合法？”
```

但它不能单独回答：

```text
“这个对象是不是 Task 创建时冻结的那一份策略？”
```

例如下面两份策略都能通过 S01-T01 Schema：

```ts
{ modelID: "kimi-k2", effectiveContextLimit: 262_144, ... }
{ modelID: "other-model", effectiveContextLimit: 131_072, ... }
```

它们各自合法，但不是同一个执行承诺。Adaptive Runtime 需要在 Task 创建、进程重启、请求重试和最终 benchmark 验证之间传播一个短小、确定、可重算的 policy identity，这就是 `modelPolicy.hash`。

## 它在 G1 中的位置

```text
S01-T01 validates ModelPolicy shape
  → S01-T02 creates and verifies policy identity
  → S01-T03 persists the complete immutable policy
  → S01-T05 admits only matching model requests
  → S01-T08 compares the resolved model before provider execution
  → S01-T10 reports same-model benchmark evidence
```

它对最终目标的贡献不是节省 token，而是保证实验约束没有在复杂调度中漂移。只有能够证明短上下文 Adaptive Runtime 和 baseline 使用了约定模型，后续效果比较才有意义。

## OpenCode baseline 原来提供了什么

### 复用 Core 的 `Hash.sha256`

OpenCode Core 已经有 [`Hash.sha256()`](../../../packages/core/src/util/hash.ts)：

```ts
export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex")
}
```

S01-T02 直接调用它，没有再次 import `crypto`，也没有维护第二个 SHA-256 实现。这让加密 primitive 的运行环境、hex 编码和未来维护都保持一致。

### 复用 S01-T01 的 `AdaptiveTask.ModelPolicy`

[`model-policy.ts`](../../../packages/core/src/adaptive/model-policy.ts) 不重新定义 policy interface。它从 `@opencode-ai/schema/adaptive-task` 引用唯一契约，所以创建结果仍然经过 S01-T01 的正整数、reserve 总量、canonical ID 和 hash 外形检查。

### 为什么逻辑放在 Core 而不是 Schema

Schema package 的职责是 browser-safe 数据契约；hash 计算依赖 Core 的 Node-compatible utility。把计算放进 Core 可以保持依赖方向：

```text
Schema defines data
  ↑
Core computes behavior
```

### Baseline 没有什么

现有 OpenCode Session 可以记录或解析 model reference，但没有“整个 Adaptive Task 生命周期只能使用这一份 ModelPolicy”的内容身份和审计语义。S01-T02 没有修改 baseline model selection；它只新增一条 Adaptive Core 路径。

## 最终实现

实现只有 [`model-policy.ts`](../../../packages/core/src/adaptive/model-policy.ts) 一个 37 行文件，对外暴露两个操作：

```ts
AdaptiveModelPolicy.create(input)
AdaptiveModelPolicy.assertEqual(expected, actual)
```

代码短不代表缺少行为。它的正确性主要来自非常窄的输入投影和覆盖每种漂移方式的测试，而不是抽象层数。

## 1. `Input` 不允许调用方提供 hash

```ts
export type Input = Omit<AdaptiveTask.ModelPolicy, "hash">
```

`create()` 的调用者只能给出执行字段。hash 必须由 Core 计算，避免普通业务代码把旧 hash 或任意字符串当作可信结果传进来。

这不是绝对安全边界，因为 TypeScript 类型可以被绕过，SQLite 也可能被外部修改；所以 `assertEqual()` 仍会在消费时重新计算。

## 2. 固定六字段 canonical projection

hash 输入不是调用方传来的原始对象，而是显式构造的新对象：

```ts
JSON.stringify({
  providerID: input.providerID,
  modelID: input.modelID,
  ...(input.variant === undefined ? {} : { variant: input.variant }),
  effectiveContextLimit: input.effectiveContextLimit,
  outputReserve: input.outputReserve,
  safetyReserve: input.safetyReserve,
})
```

字段顺序和含义为：

1. `providerID`
2. `modelID`
3. `variant`，缺省时完全省略
4. `effectiveContextLimit`
5. `outputReserve`
6. `safetyReserve`

所有会改变模型路由或上下文预算的字段都被覆盖。credential、prompt、tools、messages 不属于 ModelPolicy，因此不会被混入这个 hash；它们以后由其他审计边界处理。

### 为什么不直接 `JSON.stringify(input)`

调用方对象的 key 插入顺序可能不同，也可能带有额外 runtime property。直接 hash 它会让同一策略产生不同结果，或者让与执行无关的字段意外改变 policy identity。

显式 projection 只接受我们审计过的六个字段，并固定插入顺序。

### 为什么不用 generic stable stringify

ModelPolicy 是一个固定、扁平、只有六个字段的业务边界。引入递归 canonicalizer 会扩大需要验证的语义，例如数组、嵌套 object、数字表示和 Unicode 处理，却没有带来实际收益。这里把 canonical form 直接写出来更容易审查。

## 3. `create()` 同时计算和验证

```ts
const digest = (value: string) => `sha256:${Hash.sha256(value)}`

export const create = (input: Input) =>
  AdaptiveTask.ModelPolicy.make({
    ...input,
    hash: digest(canonical(input)),
  })
```

执行顺序是：

```text
caller fields
  → fixed canonical JSON
  → Hash.sha256
  → sha256:<hex>
  → AdaptiveTask.ModelPolicy.make()
  → validated ModelPolicy
```

最后一步再次执行 S01-T01 Schema，所以 `outputReserve: 0` 或 reserve 总和超限不会因为 hash 已经生成就被接受。

## 4. `assertEqual()` 为什么重算两边

只比较：

```ts
expected.hash === actual.hash
```

是不够的。两个对象可以一起携带同一个过期或伪造 hash。

最终实现要求四个条件同时成立：

```text
expected.hash == sha256(canonical(expected))
actual.hash   == sha256(canonical(actual))
expected.hash == actual.hash
canonical(expected) == canonical(actual)
```

前两个条件证明各自 stored hash 与各自字段相符；第三个条件比较内容 identity；第四个条件直接比较业务字段的 canonical string。

最后的字符串比较在密码学上似乎重复，因为 SHA-256 collision 极难构造，但它表达了一个更强的工程意图：ModelPolicy equality 是精确业务相等，不是“哈希大概率相等”。

失败时抛出：

```text
Adaptive ModelPolicy mismatch: expected <hash>, received <hash>
```

S01-T02 的 API 还是一个很窄的同步 Core helper，因此使用普通 `Error`。S01-T03 Store 会在读取数据库时把这类失败映射为可分类的 typed corruption error。

## 典型数据流

假设 Task 请求 Kimi 256k：

```ts
const policy = AdaptiveModelPolicy.create({
  providerID: Provider.ID.make("openai-compatible"),
  modelID: Model.ID.make("kimi-k2"),
  variant: Model.VariantID.make("default"),
  effectiveContextLimit: 262_144,
  outputReserve: 16_384,
  safetyReserve: 8_192,
})
```

得到的固定测试向量为：

```text
sha256:461b22cf2dc632671fdc8d9a34a2c31c1b044edfddbc7e41fe29a401d1801e04
```

后续不是只保存这个字符串，而是保存完整 policy 加 hash：

```text
complete fields + derived hash
```

恢复时重新读取完整字段并计算，才能发现 SQLite 中某个字段或 hash 被单独改动。

## 推荐代码阅读路线

1. 先看 [`model-policy.test.ts`](../../../packages/core/test/adaptive/model-policy.test.ts) 顶部的 `input` 和 `reordered` fixture，理解希望稳定的业务输入。
2. 阅读 [`model-policy.ts`](../../../packages/core/src/adaptive/model-policy.ts) 的 `canonical()`、`digest()` 和 `create()`。
3. 回到测试看 fixed vector、key order、undefined variant 和六字段 sensitivity。
4. 再读 `assertEqual()` 及最后三条 integrity test。
5. 最后打开 [`hash.ts`](../../../packages/core/src/util/hash.ts)，确认底层 crypto 是复用而不是新实现。

## 术语释义

### Deterministic hash

确定性 hash 表示相同输入字节永远得到相同结果。关键不是“对象看起来相同”，而是进入 SHA-256 的 canonical string 必须逐字节相同。

### Canonical projection

Projection 是从完整输入中挑出一组字段；canonical projection 进一步固定字段集合、顺序和缺省表示。这里的 projection 只服务于 ModelPolicy，不是一个通用 JSON 标准。

### SHA-256

SHA-256 把任意长度输入映射成 256-bit digest，通常表示为 64 个十六进制字符。它很适合内容 identity 和完整性检查，但不会加密原文。

### Integrity 与 authenticity

- **Integrity**：内容是否与某个已知 identity 一致。
- **Authenticity**：内容是否由有权限的主体产生。

普通 SHA-256 没有 secret key，不是数字签名。任何能修改字段的人也能重新计算 hash。因此 S01-T02 提供 integrity primitive；谁有权创建/修改记录，要由 S01-T03 的 Store 边界和后续 Controller 权限保证。

### Field drift

Field drift 指执行过程中 policy 字段偏离 Task 创建时的值，例如重试时变成另一个 variant，或恢复时使用了更大的 context limit。即使每个新值本身合法，漂移仍然违反任务级模型承诺。

### Stale hash

字段变化后继续携带旧 hash 就是 stale hash。`assertEqual()` 通过重新计算实际字段发现它，而不是因为 hash 字符串格式非法。

### Collision

Collision 指两个不同输入产生同一个 hash。对 SHA-256 而言实际风险极低；实现仍比较 canonical strings，是为了让业务相等不只依赖这个密码学假设。

## 测试看护逻辑

| 风险                                 | 对应测试                       | 实际证明                             |
| ------------------------------------ | ------------------------------ | ------------------------------------ |
| serialization 被无意修改             | fixed canonical SHA-256 vector | 六字段表示和顺序保持稳定             |
| 调用方 key 顺序影响 identity         | reordered input test           | hash 只取决于显式 projection         |
| absent 与 `undefined` 分裂成两种策略 | omitted/undefined variant test | 缺省 variant 只有一种 canonical form |
| 漏掉某个执行字段                     | six-field sensitivity test     | 每个字段独立变化都会改变 hash        |
| helper 绕过 S01-T01 budget 约束      | creation invariant test        | `create()` 仍经过 ModelPolicy Schema |
| 两个独立进程创建相同策略却无法比较   | equal policy test              | 相同字段和 derived hash 被接受       |
| 字段变化但复用旧 hash                | reused old hash test           | 两边 fresh recomputation 会拒绝      |
| 只修改 hash 字符串                   | changed hash test              | stored hash 必须匹配自身字段         |
| 两个对象使用同一个伪造 hash          | identically tampered test      | 自身 hash 重算在比较前失败           |

这些测试没有证明：

- Task policy 已经持久化且不可更新；
- 运行时解析出的 provider/model 与 policy 一致；
- provider 请求确实只发生一次；
- credential、prompt、tools 或 ContextManifest 没有漂移；
- hash 能抵抗拥有数据库写权限的恶意主体重新计算。

## 亲手验证

在仓库根目录执行：

```bash
cd packages/core
bun test test/adaptive/model-policy.test.ts
```

当前预期：

```text
8 pass
0 fail
17 expect() calls
```

再执行：

```bash
bun typecheck
```

PR #63 合并时还完成了：

- focused：`8/8`，`17` assertions；
- full Core：`1083/1083`，`2971` assertions；
- Core typecheck：通过；
- repository pre-push typecheck：`30/30` tasks；
- inline review：无 Critical、Important 或 Minor finding；
- 没有修改 baseline Session、Agent、Model、provider、Protocol、数据库或模型执行路径。

完整 Core 数量会随上游代码变化；教程中的历史数字是合并证据，当前运行应以零失败为判断标准。

## 当前边界与下一步

S01-T02 已经建立：

```text
valid fields
  → one canonical representation
  → one derived identity
  → drift-aware equality
```

但它没有负责：

- 从用户输入和 provider catalog 解析模型；
- 把 policy 写进 SQLite；
- 阻止数据库层更新 policy；
- 在 provider call 前执行 admission；
- 汇总整个 benchmark 的模型一致性证明。

这些边界分别由 S01-T03、S01-T04、S01-T05 和 S01-T08 接手。下一篇 S01-T03 教程会解释完整 policy 怎样成为可重启 Task 的权威状态，而不是只存在于当前进程对象中。

设计背景可继续阅读 [S01-T02 design spec](../../superpowers/specs/2026-07-17-s01-t02-model-policy-hashing-design.md)，最终行为以本教程链接的合并代码和测试为准。
