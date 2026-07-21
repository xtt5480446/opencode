# Adaptive Runtime 设计实现教程

这里保存 Adaptive Runtime 每个 `Sxx-Txx` 的实现伴读。它面向熟悉软件开发和 Coding Agent、但尚未熟悉 OpenCode 内部架构的工程师，目标是让读者能够理解、审查并亲手验证已经合并的实现。

## 它与其他文档有什么区别

- **Design spec** 在开发前固定需求、边界和关键取舍，回答“准备做什么、为什么这样设计”。
- **Implementation plan** 把设计拆成可执行步骤，回答“准备按什么顺序开发和测试”。
- **Tutorial** 根据最终代码和实际测试证据编写，回答“现在代码究竟怎样工作、怎样读、怎样验证、对最终目标有什么贡献”。

教程不要求读者先阅读 design spec 或 implementation plan；它可以链接这些材料作为深入参考，但必须独立可读。

## 固定交付流程

从 S01-T03 开始，每个任务按以下顺序完成：

```text
开发前任务讲解
→ 用户确认
→ TDD 实现
→ 自动化验证
→ 编写该任务 Tutorial
→ 用户按 Tutorial 阅读代码并实跑
→ 修复验收问题
→ 合并 PR 并关闭 Task
```

Tutorial 与实现位于同一个 Task、Issue 和 PR 中，是 Definition of Done 的一部分。S01-T01 和 S01-T02 在机制建立前已经合并，因此在 S01-T03 分支中一次性回补。

## 每篇教程的内容

复杂度不同的任务不追求相同篇幅，但都要回答这些问题：

1. 这个任务解决什么问题，在当前 Milestone 中承担什么角色？
2. OpenCode baseline 原来怎样工作，哪些模块被直接复用？
3. 哪些 Adaptive 语义无法由 baseline 提供，为什么需要新实现？
4. 最终代码的数据结构、模块边界和调用流程是什么？
5. 推荐按什么顺序阅读文件和关键 symbol？
6. 本任务涉及的专业术语和工程范式是什么意思？
7. 每项测试在看护什么风险，又有哪些事情尚未被这些测试证明？
8. 怎样亲手运行和观察这个特性？
9. 当前边界是什么，后续哪些 Task 会继续扩展？

正文和概念解释使用中文；代码标识符、类型名、API、SQL、命令和标准技术名称保留英文。

## Stage 1：G1 Execution Foundation

| Task    | 教程                                                                          | 产出                                                                | 状态                   |
| ------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------- |
| S01-T01 | [Adaptive Task 公共契约](./s01-t01-adaptive-task-contract.md)                 | Task/Agent/Request/Manifest ID、状态词汇、ModelPolicy、Task Summary | 已完成                 |
| S01-T02 | [ModelPolicy 确定性 Hash](./s01-t02-model-policy-hashing.md)                  | 模型执行策略的 canonical identity 与漂移检测                        | 已完成                 |
| S01-T03 | [Foundation Database 与 Transactional Store](./s01-t03-foundation-store.md)   | 可重启的 Task/Agent/Manifest/Request 权威状态                       | 已完成，随任务 PR 交付 |
| S01-T04 | [固定模型引用的直接解析](./s01-t04-direct-model-resolution.md)                | 复用 Location catalog 的 provider/model/variant 精确解析            | 已完成，随任务 PR 交付 |
| S01-T05 | [模型请求审计与准入](./s01-t05-model-request-audit.md)                        | 原子请求准入、resolved identity settlement 与确定性有效性证明       | 已完成，随任务 PR 交付 |
| S01-T06 | [有界 Agent 进程协议](./s01-t06-bounded-process-protocol.md)                  | LF-only NDJSON、严格 handshake、heartbeat 与有界 child RPC          | 已完成，随任务 PR 交付 |
| S01-T07 | [凭据隔离的 Agent 进程监督](./s01-t07-process-supervision.md)                 | 默认拒绝 child 环境、generation/lease 监督与 process-group cleanup  | 已完成，随任务 PR 交付 |
| S01-T08 | [带审计的模型网关](./s01-t08-model-gateway.md)                                | 权威 Manifest 单轮 streaming、模型一致性与 terminal audit           | 已完成，随任务 PR 交付 |
| S01-T09 | [Controller bootstrap 与 CLI runtime 隔离](./s01-t09-controller-bootstrap.md) | Adaptive 分支、管理命令与 Coordinator bootstrap 基础                | 已完成，随任务 PR 交付 |
| S01-T10 | [Packaged binary smoke 与 G1 验收入口](./s01-t10-packaged-g1-evidence.md)     | 构建产物自检、隔离环境、G1 台账与用户试跑入口                       | 已完成，G1 已验收      |

## Stage 2：G2 State, Context, and Recovery

| Task    | 教程                                                        | 产出                                                            | 状态                   |
| ------- | ----------------------------------------------------------- | --------------------------------------------------------------- | ---------------------- |
| S02-T01 | [可恢复开发状态的公共契约](./s02-t01-recovery-contracts.md) | Roadmap、Assignment、Checkpoint、恢复核验与 Task durable events | 已完成，随任务 PR 交付 |

后续教程会继续按依赖顺序加入本索引，而不是按文档创建时间排列。

## 阅读建议

第一次了解项目时，从 S01-T01 顺序阅读。定位某个实现问题时，可以直接进入对应 Task，并重点查看“代码阅读路线”和“测试看护逻辑”。

总体研究目标与系统设计见 [Adaptive Runtime Commercial V1 Program](../../superpowers/plans/2026-07-17-adaptive-runtime-v1-program.md)，但它不是阅读这些教程的前置条件。
