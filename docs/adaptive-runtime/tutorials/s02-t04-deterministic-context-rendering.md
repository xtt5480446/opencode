# S02-T04：确定性上下文部件与渲染

## 先说结论

本任务新增 `AdaptiveContextComponent` 和 `AdaptiveContextRender`。前者把一段已经确定的上下文文本封装为带有 `key`、优先级、来源版本、token 估算和可淘汰标记的部件；后者把 Roadmap、Assignment、Detail、Checkpoint 渲染为稳定的纯文本。相同的结构化输入每次都会得到相同字节序列和相同 SHA-256，因此恢复后的 Agent 可以重新构造上下文，而不依赖旧进程残留的 transcript。

它没有读取 SQLite、没有选择哪些部件进入 prompt、没有截断文本，也没有调用模型。预算计算、淘汰顺序和 immutable `ContextManifest` 持久化由 S02-T05 负责；本任务只建立这些后续步骤所依赖的稳定输入。

## 它在当前 Milestone 中的位置

S02-T01 到 S02-T03 已经把 Roadmap、Detail、Assignment、Checkpoint 变成可验证、可持久化、可由事件重建的事实。它们仍然是对象和数据库行，模型不能直接稳定地消费。S02-T04 是两者之间的窄转换层：把同一份事实转成可比较、可审计的文本部件，而不重新解释业务含义。

```text
S02-T02 durable recovery state + S02-T03 projector rebuild
  → S02-T04 deterministic ContextComponent / renderer
  → S02-T05 bounded ContextManifest assembly
  → S02-T08 replacement Agent recovery
```

这对短上下文目标的价值是可重启性。Worker 的上下文丢失后，Controller 只需从当前 Roadmap revision、Assignment 和 Checkpoint 重建需要的文本；如果源版本未变，重建结果也不会因数组插入顺序或进程运行历史改变。

## OpenCode baseline 与复用边界

OpenCode 原本的 `Session` 路径会直接把消息、工具和 compaction 结果交给模型；它的 transcript 是普通 Session 的工作历史，不是 Adaptive Task 的权威恢复输入。Adaptive Runtime 不复用这条历史作为恢复来源，避免把长程模型对话重新塞进短上下文 Worker。

本任务直接复用 `@opencode-ai/core/util/token` 的 `Token.estimate`，所以所有后续预算都使用与 Core 一致的近似 token 口径；复用 Schema package 中的 `AdaptiveRoadmap`、`AdaptiveOperation` 与 `AdaptiveEvent.DetailRecord` 类型，避免再定义一套 Roadmap 或 Checkpoint DTO。`Hash.sha256` 只在测试中确认输出字节稳定，运行时不会为渲染重复写状态。

没有复用 Session compaction 的摘要或截断语义。渲染器保留 Requirement 和 Detail 的原文，绝不为了省 token 擅自概括；是否装入 prompt、何时省略由下一层做有记录的决策。

## 最终实现

`packages/opencode/src/adaptive/context/component.ts` 定义两个小集合。`Kind` 与 `Priority` 描述部件用途和预算优先级；`create(input)` 顺序保留调用方提交的部件，但为每一项调用 `Token.estimate(text)`，并在同一次构造中拒绝重复 `key`。重复 key 会抛出 `DuplicateKeyError`，因此 S02-T05 不能在一次 Manifest 中无意覆盖两个不同来源的内容。

`packages/opencode/src/adaptive/context/render.ts` 是无状态函数集合：`requirement()`、`roadmap()`、`assignment()`、`detail()`、`checkpoint()`。它们不访问文件系统或数据库，也不修改传入的数组；需要排序时先复制数组。Roadmap node 按 ID 排序，并始终显式写出 `Owner` 或 `unassigned`，所以负责人变化必然改变恢复上下文。接口按 key/name 等字段形成完整比较，依赖按 kind/node，Detail ref 按 kind/key/version，路径和 Checkpoint 集合按稳定字典序排列。Requirement 的 Scope、Constraints、Acceptance 按输入顺序原样保留，因为它们是用户需求原文而不是可自由重排的索引。

```text
recovered typed Roadmap / Assignment / Detail / Checkpoint
  → AdaptiveContextRender pure text
  → AdaptiveContextComponent.create with sourceRevision and Token.estimate
  → S02-T05 selects and persists one ContextManifest
```

这种分离意味着重放、恢复和普通新回合可以共享同一渲染规则，而预算不足或 provider 错误不会污染渲染器，也不会产生半份 Manifest。

## 推荐代码阅读路线

1. `packages/opencode/src/adaptive/context/component.ts` 的 `Kind`、`Priority`、`Component` 和 `create()`：先理解一个将被预算器选择的最小上下文单元包含哪些可审计字段。
2. `packages/opencode/src/adaptive/context/render.ts` 的 `roadmap()` 与 `renderNode()`：看 Roadmap 的结构化索引如何变成全局导航文本，以及为何数组复制后排序。
3. 同文件的 `assignment()`、`detail()`、`checkpoint()`：看局部执行权限、精确 Detail body 和恢复进度怎样保持版本与路径信息。
4. `packages/opencode/test/adaptive/context-render.test.ts`：最后从反向插入的 fixture 和精确 golden string 验证实际输出，而不是只阅读实现猜测排序。

## 术语释义

- **ContextComponent**：直觉上是一张可取舍的上下文卡片。工程上是带稳定 `key`、`kind`、`priority`、`sourceRevision`、文本与 token 估算的不可变数据值。本项目中它让预算器能说明“为什么这段内容出现或被省略”。
- **Deterministic rendering**：直觉上是同一份资料每次打印都一样。工程上是纯函数不依赖时间、数据库返回顺序或对象可变状态，并为无序集合设定总排序。本项目中它使恢复前后的 request hash 可以比较。
- **Golden test**：直觉上是拿期望文本逐字比对。工程上是将完整、人工可审查的输出作为断言，而不是只断言包含几个关键词。本项目用它防止修改排序或标题格式后悄悄改变模型上下文。
- **Source revision**：直觉上是内容来自哪个版本。工程上是 component 上的字符串 provenance，例如 `roadmap:3` 或具体 Detail 版本；S02-T05 会把它写进 Manifest，帮助判断重启后是否需要重新装配。

## 测试看护逻辑

| 风险 | 测试方法 | 关键断言 | 证明范围 |
| --- | --- | --- | --- |
| 数据库或事件重放改变数组插入顺序 | `renders a complete Roadmap in a byte-stable semantic order` | 反向节点、接口、Detail ref 被渲染为一份精确 golden 文本，两次 hash 相同；只改 `owner` 时文本和 hash 都变化 | Roadmap 的全局导航、负责人、接口和依赖顺序可重复 |
| Worker 恢复时拿到不同路径或进度序列 | `renders Assignment, Detail, and Checkpoint collections in stable order` | Assignment、Detail 和 Checkpoint 都做完整 golden；Detail ref、路径、completed、decision、modified path 依字典序输出 | Assignment 与 Checkpoint 的局部恢复事实不会受输入顺序影响，Detail body 不被概括 |
| 预算器统计了不同 token 或 key 冲突被静默覆盖 | `estimates tokens from rendered text and rejects duplicate component keys` | `Token.estimate(text)` 被保存，重复 key 抛出 `DuplicateKeyError` | 同一 Manifest 候选中的部件身份和成本可检查 |

这些测试不证明 token 估算等于 provider 实际 tokenizer，也不证明所有部件能装进某个模型的 context limit。它们同样不验证 SQLite 查询、真实 Git diff、工具定义或模型调用；这些分别属于 S02-T05、S02-T06 和 S02-T08 的测试边界。

## 亲手验证

在仓库中执行以下命令：

```bash
cd packages/opencode
bun test test/adaptive/context-render.test.ts test/adaptive/controller.test.ts
bun typecheck
```

预期观察：测试命令显示 9 个测试通过、0 个失败；其中前三项会输出 `AdaptiveContextRender` 与 `AdaptiveContextComponent` 的名称。类型检查以 `tsgo --noEmit` 成功结束。若 golden text 失败，先比较 `roadmap()` 中的 node、interface、dependency、Detail ref 排序，而不是改变 Requirement 原文；若 token 断言失败，检查是否绕开了 `Token.estimate`。

还可运行本任务的静态检查：

```bash
cd ../..
bunx oxlint packages/opencode/src/adaptive/context/component.ts packages/opencode/src/adaptive/context/render.ts packages/opencode/test/adaptive/context-render.test.ts
```

预期输出为 0 warnings、0 errors。该命令不需要模型凭据，也不访问 provider。

## 当前边界与下一步

S02-T04 不拥有 ContextManifest ID，不会决定 mandatory、strong、requested、ephemeral 部件的装配顺序，也不处理预算不可满足、restartRequired、tail event 或 request hash。S02-T05 会读取这些 renderer 的结果，先放入完整 Requirement 和 Roadmap，再用固定 reserve 计算输入预算，记录省略原因并持久化 immutable Manifest。

渲染器也不验证恢复声明是否匹配真实工作区。S02-T06 的工具网关会采集真实 HEAD、diff、key file 与 validation evidence，S02-T08 的 replacement Worker 再使用这些事实完成恢复核验。如果这里失去字节稳定性，后续即使数据库恢复正确，也无法可靠地区分“状态真的变化”与“只是重建时输出顺序变化”。
