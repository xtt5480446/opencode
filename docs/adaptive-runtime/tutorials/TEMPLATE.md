# Sxx-Txx：任务名称

<!-- tutorial:replace-title-and-remove-every-tutorial-marker-before-opening-the-pr -->

## 先说结论

<!-- tutorial:用不依赖设计稿的语言说明最终交付了什么能力，以及没有交付什么。 -->

## 它在当前 Milestone 中的位置

<!-- tutorial:说明前置依赖、直接消费者，以及它如何服务短上下文Agent、恢复、Roadmap、模型一致性或商业交付目标。 -->

```text
Previous Task
  → This Task
  → Downstream Task
```

## OpenCode baseline 与复用边界

<!-- tutorial:先解释修改前的真实调用链，再列出直接复用的模块、仅借鉴的模式和明确不复用的语义。不要把“使用同一数据库”写成业务复用。 -->

## 最终实现

<!-- tutorial:从需求和不变量出发，解释最终数据结构、模块职责、关键API、错误路径，以及一次真实调用的数据/控制流。引用最终symbol和文件。 -->

```text
Input
  → Validation
  → Durable state / execution
  → Observable result
```

## 推荐代码阅读路线

<!-- tutorial:按读者理解成本排列文件和关键symbol，解释每一步应该看懂什么；不要按git diff顺序罗列。 -->

1. `FirstSymbol`
2. `SecondSymbol`
3. `FocusedTest`

## 术语释义

<!-- tutorial:只解释本任务实际使用的专业术语。每个术语同时给直觉、工程定义和本项目中的具体含义。 -->

## 测试看护逻辑

<!-- tutorial:把真实风险映射到真实测试与断言，并明确自动化测试没有证明什么。 -->

| 风险   | 测试方法    | 关键断言          | 证明范围           |
| ------ | ----------- | ----------------- | ------------------ |
| `Risk` | `test name` | `expected result` | `What this proves` |

## 亲手验证

<!-- tutorial:给出从正确package目录运行的命令、预期输出/状态和失败排查入口。历史PR数字与当前运行结果必须分开写。 -->

```bash
cd packages/example
bun test test/example.test.ts
```

预期观察：描述退出码、关键输出和可检查的持久状态。

## 当前边界与下一步

<!-- tutorial:明确本任务尚未实现的能力、后续由哪些Sxx-Txx接手，以及本任务失败会怎样影响下游。 -->
