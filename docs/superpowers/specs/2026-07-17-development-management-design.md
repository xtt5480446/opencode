# Adaptive Runtime 开发管理设计

## 1. 目标

本仓库同时承载冻结的 OpenCode 基线、Adaptive Runtime 产品源码、研究证据、设计、实施计划和用户验收记录。开发管理必须满足三个目标：

1. 默认 OpenCode baseline 的任何行为变化都可被独立识别和回归验证。
2. 允许在接口稳定后并行开发，但不能因并行修改公共状态模型而制造不可归因的集成问题。
3. 每个阶段都产出用户可实际运行的打包二进制；未通过用户 Gate 的代码不能进入下一阶段。

Commercial V1 期间冻结上游基线，不合并新的 OpenCode upstream commit。必须升级基线时，终止当前评测谱系，建立新 baseline tag，并重新执行已经通过的 Gate。

## 2. 仓库基线与目录

- Git 基线提交：OpenCode `5f7091ab4e261cca5383cbd57aa6aa589ed9ee86`。
- 不可移动的权威基线 tag：`upstream-baseline-5f7091a`。
- 产品源码保持 OpenCode 原目录结构，实施计划中的 `packages/...` 路径可直接执行。
- `docs/superpowers/specs` 保存批准的设计；`docs/superpowers/plans` 保存总计划和阶段计划。
- `docs/superpowers/acceptance` 保存用户 Gate 记录；`research` 保存 baseline 和后续评测证据。

仓库不包含外层实验目录、模型凭据、baseline 运行状态、构建产物、`node_modules`，也不包含 `.baseline-task-export-fix` 中未提交的用户修改。`upstream` 指向 `anomalyco/opencode`，`origin` 指向用户账号下的 GitHub fork。

## 3. 分支、Worktree 与提交

### 3.1 长期引用

- `main`：只包含已经通过最近一个用户 Gate 的集成状态，以及下一阶段开始前批准的设计/计划更新。
- `stage-01` 至 `stage-06`：当前阶段的唯一集成分支，从上一个 accepted commit 创建。
- `upstream-baseline-5f7091a`：指向官方 commit 的冻结基线 tag，任何开发操作不得移动。
- `g1-accepted` 至 `g6-accepted`：用户在验收记录中明确接受后，打在对应 `main` commit 上。

### 3.2 任务分支

每个实施任务使用独立分支和独立 Git worktree，命名为 `sNN-tNN-topic`，例如 `s01-t03-store`。任务分支只包含该任务计划列出的文件、测试和生成物。一个任务可有多个 red/green commit，但合入阶段分支前必须形成可独立 review、可独立回滚的完整变更。

任务分支不得直接合入 `main`。集成顺序为：

```text
task branch -> focused verification -> review -> stage-NN
stage-NN -> stage regression -> packaged E2E -> user Gate
accepted stage-NN -> main -> gN-accepted
```

用户 Gate 失败时继续修复原阶段，不创建下一阶段分支，不用后置事项或豁免项绕过失败。

## 4. 串并行模型

六个阶段严格串行，因为后续阶段依赖前一阶段已经由用户验证的运行语义。阶段内部使用任务依赖图，不按任务编号无条件串行。

允许两个任务并行必须同时满足：

1. 它们依赖的 Schema、事件、服务接口和迁移版本已经合入阶段分支并冻结。
2. 主要文件所有权不重叠；特别是 `adaptive-operation.ts`、`adaptive-event.ts`、`adaptive/sql.ts`、`controller.ts` 和迁移生成文件同时只允许一个任务修改。
3. 任一任务都能在不依赖另一个未合入工作区的情况下运行 focused tests。
4. 合并顺序不会改变 baseline 或 ModelPolicy、ContextManifest、Roadmap、Evidence 等公共语义。

阶段内最多同时维护三条实现工作流；Stage 1-2 默认最多两条，因为它们建立公共状态和恢复脊柱。

| 阶段 | 可并行工作流 | 串行汇合点 |
|---|---|---|
| 1 | Schema/Store/Audit；Process Protocol/Supervisor | Model Gateway、Controller、CLI、打包 |
| 2 | Store/Projector；Context/Tool Gateway | Agent Loop、Recovery、G2 fixture |
| 3 | Roadmap Validator/Store；Discovery/RepoMap | Coordinator Cycle、G3 fixture |
| 4 | Workspace；Scheduler/Contracts；Communication | Multi-Worker Controller、G4 fixture |
| 5 | Evidence/Validator；Integration/Materialize；API/Operations | Completion、export、G5 fixture |
| 6 | Provider/Quota；Security/Benchmark；Observability/Backup | Load/soak、release package、G6 |

并行任务通过阶段分支中已经冻结的接口通信，不读取其他任务 worktree。公共接口需要改变时，先暂停受影响分支，在阶段分支提交接口变更和影响分析，再重新建立下游任务基线。

## 5. 正确性证明层级

UT 是每个任务的准入条件，不是大特性的最终验收。

### 5.1 任务级

每个任务必须依次提供：

1. 失败原因正确的 red test，而不是语法、fixture 或环境失败。
2. Schema/typecheck 和纯逻辑 UT，覆盖边界、错误类型和不变量。
3. 涉及 SQLite、Git、进程、文件系统或 HTTP 时，增加真实组件集成测试。
4. 修改共享路径时，运行受影响包的回归测试和 baseline parity test。
5. 计划列出的生成文件无 drift，提交中不含未声明文件或敏感信息。

### 5.2 阶段级

- G1：打包二进制启动子进程；默认/显式 baseline 等价；真实模型审计和凭据隔离通过。
- G2：在读代码、半编辑、关键决定和失败测试后强杀 Worker；替代进程从外部状态恢复并完成 fixture。
- G3：Coordinator 强制重启后 Roadmap 仍全局自洽；用户实际检查骨架和完整接口 Detail 是否足以导航。
- G4：真实并发时间区间、契约 commit 祖先关系、路径隔离、脏仓和空目录保持；用户运行两个产物。
- G5：Controller 验证、独立 Validator、代码/语义冲突、TTY/API 恢复、原子 materialization 和软件行为全部通过。
- G6：真实长任务、baseline/adaptive 同模型 pair、离线有效性验证、安全扫描、跨平台打包和 24 小时 soak 通过。

阶段 Gate 之前必须执行独立 code review。测试通过不能替代用户运行；用户运行也不能替代自动化回归和证据审计。

## 6. CI 与验证频率

CI 分四层：

- Task CI：focused test、typecheck、相关 package regression，目标分钟级反馈。
- Stage CI：Schema/Core/Client/OpenCode 全量测试、迁移 drift、HttpApi exercise、强制恢复和 Git/process integration。
- Gate CI：本机打包二进制 E2E、fixture 验收、证据 export、用户试跑说明。
- Release CI：平台矩阵、安全/secret scan、benchmark validity、chaos/leak/load 和 24 小时 soak。

所有阶段都运行 baseline parity；不能把 baseline 回归推迟到 G6。非确定性测试必须使用固定 seed 并在失败输出 seed。只有 G1-G6 用户试跑使用真实模型，普通 CI 使用可记录、可重放输出的 fake provider，但仍经过真实 Model Gateway 和审计路径。

## 7. 开发节奏

每个阶段采用相同闭环：

1. 从最新 accepted commit 创建阶段分支。
2. 先合入该阶段的公共 Schema/事件/接口任务。
3. 对满足并行准入条件的任务创建独立 worktree，最多并行两到三条。
4. 每个任务完成 red/green、focused tests、review 后合入阶段分支。
5. 在阶段分支执行全量集成、打包和独立 review，修复后完整重跑。
6. 提供二进制、命令、fixture 和证据给用户；等待用户更新 Gate 记录。
7. 用户接受后合入 `main`、打 accepted tag，再创建下一阶段分支。

Stage 1 首轮只并行两条工作流：一条实现 Task 1-5 的 Schema/Store/Audit 基础，另一条实现 Task 6-7 的进程协议与监督。Task 8-10 在两条基础工作流合流后串行完成，以降低第一条商业可运行路径的集成风险。

## 8. 明确后置

- GitHub Issues/Projects、保护分支和云 CI 在 remote 确定后配置。
- Commercial V1 完成前不做 upstream sync。
- 不因并行开发引入多模型、长模型回退或另一套 Agent/Tool/Permission 框架。
- 不为了提高并行度拆分本应原子提交的 Schema、迁移和生成文件。
