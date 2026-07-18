# S01-T03：Live Tutorial Gate Probe

## 先说结论

这是一份只用于验证 GitHub 实机门禁链路的临时教程，不包含产品实现，也不会合并到集成分支。它证明完整中文教程存在时，门禁仍会根据 PR 中可见的任务字段、路径字段和确认框决定是否放行。

## 它在当前 Milestone 中的位置

该探针位于正式 S01-T03 开发恢复之前，用来验证教程交付约束已经从本地测试升级为远端合并门禁。探针关闭后不会改变当前 Milestone 的产品状态，也不会替代后续数据库与事务存储任务的真实教程。

## OpenCode baseline 与复用边界

实机检查复用 GitHub Actions、仓库中的 Bun setup action、Git name-status diff 和 OpenCode 已使用的 Markdown parser。它不调用模型、不启动 Session，也不修改 baseline Agent、工具循环、数据库或任何用户可见的运行时行为。

## 最终实现

测试分支新增一个符合命名规范的教程文件和一条真实索引链接。默认分支上的 trusted workflow 读取 PR event，从 head commit 读取 Markdown 数据，但不 checkout 或执行 head 代码，然后返回可观察的失败或成功状态。

## 推荐代码阅读路线

先阅读 workflow 以理解可信代码来自哪里，再阅读 validator 观察 PR event 如何转换为验证输入，最后阅读聚焦测试确认 comment、code fence、非法 Task 和 ruleset drift 都无法绕过。这个顺序能把安全边界、业务规则和回归证据连起来。

## 术语释义

所谓 live gate，是指在真实 GitHub PR 上运行并能形成合并状态的检查。所谓 trusted revision，是指工作流与校验器来自默认分支的已审查提交，而 PR head 只作为待验证数据读取，因此贡献者不能通过修改检查脚本让自己通过。

## 测试看护逻辑

第一次运行保留可见的 N/A 字段和未勾选确认框，必须失败并报告三个声明错误。第二次只修改 PR body 为合法 Task、精确教程路径和已勾选确认框，必须成功。两次使用相同 head commit，可以隔离证明状态变化来自元数据校验。

## 亲手验证

在 GitHub PR 的 Checks 页面打开 adaptive-tutorial job，第一次应看到失败诊断，编辑 PR body 后应出现新的成功运行。还要检查 workflow checkout 的是 workflow SHA，读取教程使用 git show，并确认临时 PR 最终关闭而不是合并。

## 当前边界与下一步

该探针只证明教程门禁的端到端行为，不证明正式 S01-T03 产品代码正确，也不评价真实教程的技术质量。验证完成后会关闭 PR、删除临时分支，再启用 stage ruleset、同步教程机制并更新全部任务 Issue 的 Definition of Done。
