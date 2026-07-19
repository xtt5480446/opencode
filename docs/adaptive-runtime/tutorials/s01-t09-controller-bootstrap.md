# S01-T09：Controller bootstrap 与 CLI runtime 隔离

本任务把 Adaptive Runtime 接到真实 OpenCode CLI，同时保留默认 baseline 路径。`run --runtime adaptive` 在进入旧 Session 创建逻辑前分支；`adaptive doctor/status/export` 提供基础运维入口。

## 关键实现

- `adaptive/controller.ts` 负责把请求模型解析为不可变 `ModelPolicy`，创建 Task 和 Coordinator Agent，然后由 `AdaptiveProcessSupervisor` 取得真实 generation/owner，再写入 bootstrap Manifest。
- 子进程的 `model.stream` 只能经 `AdaptiveModelGateway`；Controller 不直接调用 provider，也不执行工具或多轮 loop。
- `run.ts` 的 baseline 分支保持原有 SDK/Session 流程；Adaptive 分支只输出 Task ID/status。
- `adaptive doctor --offline --json` 检查数据库、进程命令、协议和审计基础，不触发 provider I/O。

## 为什么重要

这是从基础设施到可运行 Agent 的接缝：Task、Manifest、generation、Supervisor 和 Gateway 首次在一次 CLI 调用中串起来。默认 baseline 不被改写，评测可用显式 runtime 选择。

## 测试

Controller 单测锁定固定 bootstrap system text 和 legacy 参数拒绝；CLI subprocess 测试运行真实入口，验证 doctor 退出 0、Adaptive JSON 首事件包含 Task ID。TypeScript typecheck 保证服务层依赖完整。

```bash
cd packages/opencode
bun test test/adaptive/controller.test.ts test/cli/adaptive-process.test.ts
bun typecheck
```

当前测试不证明真实 provider 凭据或 packaged binary；后者由 S01-T10 负责。
