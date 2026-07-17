# Adaptive Runtime 设计

日期：2026-07-17

状态：待用户审阅

## 1. 研究目标

本项目基于 OpenCode 新增一条并行的 Adaptive Runtime，用冻结的、合理上下文长度模型完成长程 Coding 任务。

核心研究命题是：超过合理序列长度后，继续扩大模型原生上下文的边际收益，可能低于 Agent 层对项目状态、局部上下文和多 Worker 协作的结构化管理。

首要目标不是减少调用次数，而是提高最终代码质量。允许同一个短上下文模型进行更多轮调用和启动多个独立 Agent 进程，但不允许使用其他模型、长模型兜底、embedding 或 reranker。

## 2. 已有 OpenCode 证据

标准 `opencode run` 当前走 legacy `SessionPrompt`，不是 V2 `SessionRunner`。它在每个 provider turn 中回放保留的时间序列历史，接近上下文上限后再生成摘要并裁剪旧工具输出。

两次 baseline 探针暴露了与本研究直接相关的问题：

- 架构调查在单轮上下文达到约 100k token 时，仍混淆了默认 legacy 路径和并存的 V2 路径。
- 一个明确给出根因线索的 export 修复任务处理了约 110 万累计 turn token，最终实现有效，但新增测试没有覆盖真实生产路径。
- OpenCode 的 task subagent 只接收局部 prompt，不自动继承全局项目骨架和依赖契约。
- legacy Runner 和 BackgroundJob 是进程内状态；V2 虽有持久化输入和事件，但仍以 Session 历史作为模型上下文主轴。

因此 Adaptive Runtime 复用 OpenCode 的编码基础设施，但不复用它的 Agent 控制循环和上下文策略。

## 3. 不可违反的约束

1. 默认 `opencode run` 保持原样，作为 baseline。
2. 新模式通过 `opencode run --runtime adaptive` 进入独立执行路径。
3. 同一个 Task 内所有 Coordinator、Worker、Validator 和 Integration Agent 使用同一个 provider/model。
4. 模型选择和有效上下文上限在 Task 创建后不可修改。
5. 不使用 embedding、reranker 或长模型辅助检索。
6. 完整 Roadmap 骨架始终注入模型，目标预算约为 50k token 以内。
7. 代码、编译、测试和运行结果是高于模型自述的事实来源。
8. Roadmap 与 Agent 状态默认不写入用户仓库。
9. 普通模式下 Requirement/Roadmap 冲突必须暂停并请求用户决策；Benchmark 模式不得请求人工帮助。
10. 空工作区只是给定工作区的一种边界情况，不引入 greenfield/brownfield 两套 Runtime。

## 4. 总体边界

```text
OpenCode CLI / Adaptive API
            |
Adaptive Controller（确定性系统）
            |
            +-- Coordinator Agent
            +-- Discovery Worker
            +-- Implementation Worker
            +-- Validator Worker
            +-- Integration Worker
```

Adaptive Controller 不是 LLM。它负责持久化、版本检查、状态推进、进程监督、上下文预算、Git/worktree、验证命令和模型一致性审计。

Coordinator 和 Worker 都是可独立启动、销毁和恢复的完整 Agent 进程。Worker 不是 OpenCode task tool 创建的受限子会话。

Coordinator 负责全局语义决策，但默认不修改代码。所有代码变更由 Implementation Worker 完成。小任务走单节点快速路径，而不是让 Coordinator 兼任编码者。

## 5. Roadmap 的真实职责

Roadmap 不是完整项目文档，也不是聊天摘要。它的职责是：任何新 Agent 看到它后，都知道当前任务有哪些工作单元、它们如何协作、当前状态是什么，以及应该通过哪些 key 打开详细信息。

Roadmap 包含两层信息：

- Requirement Baseline：原始用户目标、范围、约束和最终验收标准。普通模式下只有用户能够改变其含义。
- Execution Graph：节点、接口、依赖、状态、风险、负责人、验收方式和 Detail keys。Coordinator 可以在不违反 Requirement Baseline 的前提下持续更新。

一个 Roadmap 节点表示可独立分工、有明确接口并能够独立验收的工作单元，不对应单个文件或一次操作。

全局 Roadmap 中的节点只保留：

- 节点目标和状态；
- 当前负责人；
- 对其他节点可见的接口摘要；
- hard、contract、informational、validation 依赖；
- 风险和 unresolved 项；
- requirements、contracts、decisions、validation 等 Detail key。

Detail Pool 只承担四类长期信息：

- requirements：当前节点必须实现的行为；
- contracts：节点与其他节点如何通信；
- decisions：后续不能遗忘的关键选择、理由和依据；
- validation：如何证明节点正确，以及证据是否仍然有效。

临时代码进度不进入 Roadmap，而进入 Worker checkpoint。大型原始日志和工具输出保存为外部内容引用，不塞入 Roadmap 或 Detail 正文。

SQLite 是权威状态。Roadmap 更新保留版本和变更历史，Detail 的每个版本不可变。用户可以通过 CLI/API 查看和导出可读视图，但内部状态默认不污染目标仓库。

## 6. 为什么能够重建上下文

Roadmap 和 Detail 只能恢复全局认知，不能单独恢复一个做到一半的 Worker。完整恢复依赖三层事实：

```text
全局状态：Roadmap + Detail
任务状态：Assignment + 接口 + 验收条件
执行状态：Checkpoint + worktree/diff + 工具事件
```

### 6.1 Worker 重建

新 Worker 的模型输入由以下内容重新生成：

```text
固定 Worker 指令
+ 最新完整 Roadmap
+ 当前 Assignment
+ 当前节点及直接依赖 Detail
+ Worker checkpoint
+ 当前 worktree commit/diff
+ checkpoint 后尚未归档的工具和通信事件
+ 有界的最近局部尾部
```

Worker checkpoint 至少说明已经完成什么、关键决策、修改范围、验证结果、剩余问题和下一步动作。

关键决策不能等到上下文将满时才统一总结。Worker 在确定接口、引入重要假设、改变方向或发现风险时，必须立即把结论和理由写入当前节点 Detail。

新 Worker 不能盲信 checkpoint。恢复后的第一步是检查 `git status/diff`、关键文件和最近验证结果。若模型交接与代码现实冲突，以代码和可复现验证为准，并上报风险。

### 6.2 Coordinator 重建

Coordinator 不保存无限主对话。每次唤醒只处理一个有限事件批次：

```text
读取某个 Roadmap revision
+ 读取尚未处理的 Worker/验证/风险事件
+ 按需打开相关 Detail
-> 产生 Roadmap 更新、调度决定或冲突上报
-> Controller 原子提交决定和事件位置
```

提交前崩溃时数据库没有变化，同一批事件可以重新处理。提交后崩溃时，新 Coordinator 从新 revision 和下一个事件位置继续。

Coordinator 的关键意图必须已经表现为已提交的 Roadmap 更新、DispatchPlan 或 Conflict，不允许只存在于模型聊天中。

## 7. Context Assembler

Adaptive Runtime 不等到接近模型上限后再 compaction。每个 provider turn 前都从外部状态重新组装模型输入。

内容按语义优先级处理：

- 不可驱逐：Requirement Baseline、完整 Roadmap、Assignment、当前节点和直接依赖契约；
- 强相关：当前节点完整 Detail、当前 diff、失败验证和未解决风险；
- 按需加载：Worker 主动打开的其他 Detail、轻量 RepoMap 和近期工具结果；
- 临时信息：局部对话尾部和已成功命令的详细输出。

Roadmap 约束在约 50k token。Context Assembler 为工具 schema、模型输出和突发错误保留安全空间，并在每轮记录实际注入内容、原因、token 占用和被驱逐内容。

达到软阈值时先持久化关键状态和 checkpoint，然后主动重启 Worker，不调用 compaction Agent。

如果不可驱逐内容本身无法放入预算，说明节点粒度或依赖边界错误，必须拆分节点或交给 Coordinator 处理，不能通过有损摘要强行继续。

Roadmap 使用稳定排序和确定性序列化，以便相同外部状态产生相同 ContextManifest，并尽量保持 provider prompt cache 前缀稳定。

## 8. 轻量 RepoMap

本设计不尝试通过静态分析推导真实软件依赖图。

轻量 RepoMap 只记录可确定的导航事实，例如目录、package、文件位置、显式 import/export、符号定义、构建入口和测试入口。它相当于结构化的 `rg + LSP`，帮助 Worker 定位代码。

影响调度和上下文加载的语义依赖由 Coordinator 写入 Roadmap，并由代码阅读、编译、测试和运行验证。仓库为空时 RepoMap 自然为空，并随代码产生逐步更新。

## 9. Task 启动与完整时序

### 9.1 创建 Task

CLI 固化原始需求、工作区、初始 Git snapshot、模式、ModelPolicy、资源预算和上下文预算。任何 Agent 调用前先启用模型使用审计。

### 9.2 Roadmap R0

Coordinator 根据需求、项目说明和已有工作区事实创建初始 Roadmap。不了解的内容通过正式 unresolved 或 discovery 节点表达，不允许假装已经知道。

只有会阻碍模块拆解、接口或验收的问题才启动 Discovery Worker。Discovery Worker 是拥有完整 Roadmap 的独立只读 Agent，负责回答一个具体代码问题，不扫描整个仓库，也不生成自动依赖图。

多节点或高风险任务首次进入实现前，由使用同一模型但全新上下文的 Roadmap Reviewer 检查需求遗漏、全局矛盾、接口和验收缺口。Reviewer 只提出问题，Coordinator 负责修改 Roadmap。简单单节点任务可跳过这一轮。

### 9.3 调度

Controller 根据状态和依赖计算合法可运行节点集合。Coordinator 决定优先级、Worker 分工和并行组合。Controller 再检查版本、worktree、写入范围和资源限制，然后启动 Worker。

不要求 Roadmap 所有细节全部 ready。只要一个节点的必要依赖已经满足，它就可以与其他 discovery 并行执行。

### 9.4 实现、验证和集成

Implementation Worker 完成代码后通过 `report.submit` 提交 candidate。模型在普通文本中声称完成不会推进状态。

Controller 在受控环境中重新执行节点验收命令，然后启动全新上下文的 Validator。Validator 读取原始需求、契约、diff 和验证证据，主动寻找遗漏、错误假设和测试缺口，但不读取实现 Worker 的推理历史。

无冲突 Git 合并由 Controller 完成。代码级冲突交给 Integration Worker；语义或接口冲突升级给 Coordinator。合并后的 commit 必须重新执行受影响验证。

### 9.5 完成

Task 只有在 required 节点全部集成、阻塞问题已解决、全局验收通过、模型一致性通过且没有未处理 Worker 或未知副作用时才能完成。

最终报告由 Coordinator 基于 Roadmap 和 Evidence 生成；Controller 附加确定的 Git commit、测试结果和模型使用证明。

## 10. 独立 Worker 与 worktree

每个 Worker 拥有独立 Session、模型循环、上下文预算和生命周期。

实现型 Worker 默认使用独立 Git worktree。只读 Discovery Worker 可以共享仓库。需要在共享工作区写入时必须持有排他锁。

Worker 可以被中止、销毁和恢复。恢复身份由 Worker ID、Assignment、Roadmap revision 和 checkpoint 共同确定。

Worker 拥有完整 OpenCode 编码工具，并额外获得少量 Adaptive 工具：

- `detail.open`：按 Roadmap key 读取细节；
- `decision.record`：外化关键决定；
- `dependency.report`：报告依赖、接口或信息问题；
- `checkpoint.save`：保存工作交接；
- `report.submit`：提交 candidate 和剩余风险。

Worker 只能修改自己节点允许的 Detail，不能直接修改全局 Roadmap 或把节点标记为完成。

## 11. 依赖和并行

Roadmap 依赖分为：

- hard：上游必须集成并验证；
- contract：上游契约冻结后可以并行；
- informational：当前判断为非前置条件，可按需读取；
- validation：实现可并行，但完成依赖共同验证。

informational Detail 未 ready 时，Worker 不能假装已经读取。它可以继续不受影响工作、提出问题，或者发现该信息实际影响正确性后把依赖升级为 contract/hard 并暂停相关工作。

支持并行的 contract 不能只是一段自然语言。已有契约必须绑定某个 commit 中的真实类型、函数或 schema；新契约必须先以类型、schema、stub 或 contract test 形式合入集成分支并通过类型检查。

下游 Worker 从包含冻结契约的 commit 创建 worktree。冻结契约变更时，受影响 Worker 暂停，旧验证失效，契约重新合入后才能继续。

## 12. 跨 Worker 通信

Worker 可以直接协作，但不能进行不可追踪的私聊。依赖问题、接口提议、风险、阶段进度和完成报告都通过 Controller 路由并持久化。

接收方看到的是结构化结论、更新后的契约和相关 Detail，而不是发送方的完整聊天历史。全局影响由 Coordinator 处理，代码级问题由相关 Worker 处理。

## 13. Roadmap 更新和冲突

正常证据追加和兼容性细化可以自动提交。修改冻结接口、依赖或验收条件时，Controller 暂停受影响节点并使相关验证失效，由 Coordinator 给出影响分析和重规划。

如果用户需求、Requirement Baseline 和已承诺全局方向无法同时成立，Task 进入 Requirement/Roadmap Conflict，普通模式停止所有工作并请求用户决策。Benchmark 模式由 Coordinator 自主选择并记录理由。

普通终端运行不需要全屏 TUI。发生冲突时，CLI 可以在当前 TTY 展示证据和选项，用户选择后继续。非 TTY/API 环境输出 `needs_input` 并允许后续通过 conflict ID 恢复。完整 TUI 可视化后置。

## 14. 验证的权威性

节点进入 ready 前先明确需要证明的行为、可观察结果和验证方式。

现有仓库测试、构建命令和 benchmark 隐藏测试属于外部约束。Implementation Worker 可以增加测试，但不能只凭自己新增的测试证明正确，也不能无审查地删除、跳过或弱化原有验收。

权威顺序为：

```text
用户需求
> 预先确定的验收行为
> 合并后可复现的运行证据
> Validator 判断
> Implementation Worker 自述
```

验证证据绑定具体 commit 和 Roadmap revision。代码或契约变化后，受影响证据自动失效并重新执行。

## 15. 模型一致性

所有 Agent 请求必须经过 Controller 管理的 Model Gateway。Worker 进程不持有 provider 密钥。

每次请求记录 Task、Agent、角色、provider、resolved model、variant、ModelPolicy hash、有效上下文上限、token 和重试关系。

Task 结束时必须验证：

- 只出现一个 provider/resolved model；
- 所有请求使用同一个 ModelPolicy；
- 所有请求符合有效上下文上限；
- 不存在无法关联到 Task 的辅助模型调用；
- 不存在绕过 Model Gateway 的 Agent 请求。

违反任一条件时 benchmark run 标记为 `INVALID_MODEL_MIXING`，不能计入结果。Baseline 也使用行为无侵入的模型审计；若 OpenCode 选择其他 small model，同样判定无效。

## 16. Tool、shell 和进程恢复

Adaptive 复用 OpenCode 已有的 CrossSpawnSpawner/AppProcess、POSIX 进程组终止、SIGTERM 到 SIGKILL 升级、工具状态持久化、中断输出保留和 V2 遗留 tool call 清理。

现有 BackgroundJob 是进程内状态，不用于管理持久化 Worker。

Adaptive 只补充跨进程 Worker ownership/lease。整个进程突然死亡后，遗留 running tool 被标记为 interrupted，但不会自动重放。恢复 Worker 通过 worktree diff、进程状态和重新验证判断现实结果。

Benchmark 默认禁止 push、创建 PR、发布包和修改远程服务等外部副作用。必要 package install 可以运行，但 lockfile 和文件结果必须进入 worktree 证据。

## 17. OpenCode 改造位置

CLI 增加 `--runtime baseline|adaptive`，默认 baseline，并增加 status、roadmap、conflict、resume 和 export 等管理入口。

OpenCode Core 增加 Adaptive Task、Roadmap、Detail、Worker、Checkpoint、Evidence 和 Conflict 的持久化及确定性状态逻辑。OpenCode Runtime 增加 Controller、Context Assembler、Agent 进程监督、worktree 管理和验证执行。

复用 Provider、模型解析、认证、LLM adapter、编码工具、Permission、Project、Git/worktree、Snapshot、SQLite、Event、配置和日志。

不复用 legacy `SessionPrompt.loop`、MessageV2 时间序列上下文选择、SessionCompaction、TaskTool 子会话和 legacy SessionRunState。

从 V2 Runner 中复用或抽取“给定显式 messages/tools，执行一次 provider turn 并结算工具事件”的能力。Adaptive 自己提供上下文、continuation 和恢复策略。

## 18. 实施阶段

### 阶段 1：独立执行路径

打通 runtime flag、Controller、Model Gateway、模型审计和显式输入的单轮 LLM/tool 执行。验收同一二进制可以明确选择 baseline/adaptive，且 baseline 行为未改变。

### 阶段 2：上下文重建

实现单 Coordinator、单 Implementation Worker、Roadmap、Detail、decision、checkpoint 和 Context Assembler。用真实 coding 任务多次强制重启 Worker 和 Coordinator。

这是第一个研究里程碑：单 Worker 清空上下文后仍能可靠恢复并完成任务。

### 阶段 3：模块分工

增加多 Worker、独立 worktree、冻结契约、依赖调度、Validator、Integration Worker、跨 Worker 通信和冲突暂停。

### 阶段 4：正式评测

增加 Benchmark 模式、完整有效性审计和正式任务矩阵。具体任务集、模型组和统计方法由独立评测设计确定，不属于本设计文档的既定结论。

## 19. 测试重点

确定性 Controller 逻辑使用不调用真实 LLM 的快速测试。Contract 重点覆盖 draft/frozen、base commit、过期 Assignment、冻结契约变更、证据失效、重复事件和重启幂等性。

Git/worktree 和并发使用真实临时仓库集成测试，覆盖契约合入、下游分支基线、并发提交、合并与状态更新之间崩溃。

上下文机制必须进行强制失忆测试：

- Worker 在读代码后、修改一半、记录决策后和测试失败后被杀死；
- Coordinator 在读取事件前、提交决定前和提交后被杀死；
- 大型 Detail 和工具输出验证预算及驱逐顺序；
- 审计每个模型请求，确认旧聊天没有绕过 Context Assembler；
- 同一任务比较不重启和固定位置多次重启的正确性、重复工作、token 和耗时。

只有强制失忆后仍能完成任务，才能证明关键信息已经从模型上下文迁移到 Agent 系统。

## 20. 明确后置内容

- 完整 TUI、桌面端和 Web 可视化；
- 自动静态语义依赖图；
- 多模型路由和长模型兜底；
- embedding 或语义 reranker；
- 远程发布、PR 创建和部署；
- 训练侧与 Agent 联合优化。

这些内容不进入首版 Adaptive Runtime，也不能影响首轮研究归因。
