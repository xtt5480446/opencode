# S01-T07：凭据隔离的 Agent 进程监督

## 先说结论

S01-T07 把 S01-T06 的有界 stdio 协议接到了真实 OS child、S01-T03 的 durable Agent lease 和 OpenCode Core 已有的 process-group spawner 上。Controller 现在可以用 `AdaptiveProcessCommand.make()` 创建默认拒绝环境继承的命令，再由 `AdaptiveProcessSupervisor.start()` 完成 hello identity 校验、generation CAS claim、accepted/ready handshake、heartbeat lease、child-originated RPC routing 和退出 settlement。child 或 grandchild 不响应 SIGTERM 时，复用的 Core spawner 会在三秒后对仍然存在的整个 POSIX process group 发送 SIGKILL，即使 direct child 已先正常退出。

本任务没有实现 Model Gateway、provider 调用、Controller bootstrap 或具体 Agent 工作循环。隐藏命令里的 production role 只等待 `shutdown`；S01-T08 会把 supervisor 的窄 router 接到 audited gateway，S01-T09 才负责 Controller bootstrap 和实际 role loop。

## 它在当前 Milestone 中的位置

S01-T03 提供 generation、owner、PID 和 lease 的 CAS Store，S01-T06 提供 child handshake、heartbeat 和有界 RPC wire contract。本任务把两者组合成真实进程所有权：只有 durable generation claim 成功的 child 才能收到 `accepted`，因此 stale process 不能进入 RPC routing，也不能续租其他 Agent。后续 gateway 和 Controller 可以依赖这条边界，而不必各自重新实现进程身份或 kill 语义。

```text
S01-T03 durable Agent generation and lease
  + S01-T06 bounded child protocol
  → S01-T07 credential-free command and process supervision
  → S01-T08 audited model router
  → S01-T09 Controller bootstrap and role loop
```

这条能力直接服务短上下文恢复：新的进程 generation 只能由 Store claim 产生，旧进程即使迟到也无法被接受；heartbeat 停止后同一 generation 会标记为 `lost` 并清理完整进程组，后续恢复才能安全创建下一代进程。

## OpenCode baseline 与复用边界

OpenCode Core 的 `cross-spawn-spawner.ts` 已经把 Effect `ChildProcessSpawner` 适配到 `cross-spawn`，并在 POSIX 默认创建 detached process group。T07 直接复用这个 handle、stdin Sink、stdout/stderr Stream 和 scope cleanup，没有新增 Bun.spawn/Node spawn 的 production wrapper。本任务同时修正了共享 `handle.kill({ forceKillAfter })` 的终止语义：实际 `detached: false` 的 direct child 按单进程 exit signal 等待并升级，detached POSIX child 则持续观察整个 group；deadline 到达且 group 仍存在时才发送 group SIGKILL，随后再做最长三秒的有界观察。scope cleanup 复用同一条路径，group 已消失可以提前返回，最终仍存活会得到 typed `PlatformError`。liveness probe 与 signal 之间发生退出时，POSIX `ESRCH` 现在按“已经消失”处理，`EPERM` 和其他错误仍作为 typed failure 返回；Windows 继续使用原有 `taskkill /T /F` tree kill。

baseline 没有 Adaptive identity、Store claim 或 credential scrub。普通 `extendEnv` 可以继承 Controller 的 provider key、auth content、proxy credential 和进程内 RPC state，因此不能直接用于独立 Agent。`command.ts` 新增的是 Adaptive 专属命令策略；`supervisor.ts` 新增的是协议与 durable ownership 的组合。Core 的修改只收紧共享 process-group force deadline，不包含 Adaptive 专属逻辑。

测试 fixture 只通过注入 command factory 替换可执行文件，仍复用 production `agentArgs()` 与 `options()`；production `AdaptiveProcessCommand.make()` 没有 entry override、probe flag 或额外 argv。Linux 的真实 hidden-child 环境检查直接读取 `/proc/<pid>/environ`，不会要求 child 把原始环境或 secret 回传给 Controller。

## 最终实现

`AdaptiveProcessCommand.environment()` 从默认拒绝开始，只保留 `PATH`、必要的 Windows shell/system 变量、home/temp、locale、`NO_COLOR` 和少量明确的非敏感 OpenCode disable flags。即使未来误把新名字加入 allowlist，匹配 `KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE` 的名字仍会被第二道过滤拒绝。`extendEnv` 固定为 `false`，三个 stdio 都是 pipe，POSIX command detached，`forceKillAfter` 固定三秒。

`make()` 根据当前入口选择 source 或 packaged argv。source 使用当前 Bun executable 加 `run --conditions=browser <entry> __adaptive-agent`，compiled binary 直接以自身 executable 加 `__adaptive-agent`；两者后面只有严格的 Task ID、Agent ID、generation 和 role。cwd 来自 durable Task directory，而不是 Controller 当前目录。

Supervisor 启动顺序如下：

```text
get durable Agent and Task
  → predict next generation and spawn scrubbed command
  → immediately own startup cleanup for every failure/interruption
  → decode and validate exact hello identity
  → AdaptiveStore.claimAgent(expected generation, owner, PID, 20s lease)
  → send accepted(heartbeatMs = 5s)
  → require ready
  → renew the exact durable lease for a full 20s
  → arm the matching local deadline before start returns
  → route heartbeat / rpc.request / rpc.cancel
  → settle stopped, lost, or failed and close stdin on exit
```

spawn 成功后，Supervisor 会立即建立 startup cleanup ownership，再启动 stdin/stdout/stderr fiber 和 handshake。hello timeout、stdout EOF、decoder error、ready timeout、ready EOF，或任意 startup interruption 都必须先 kill process group、关闭 stdin，再把错误返回调用方；若 Store claim 已成功，同一 owner/generation 会先结算为 `failed` 并清空 owner、PID 和 lease。成功返回 `Handle` 后，cleanup ownership 才转交给调用方 scope 的 finalizer。

terminal path 由单一不可中断 owner 执行：process-group kill、exit observation、pending RPC interruption、stderr reader、Store settlement 和 Queue/PubSub shutdown 都有独立 deadline。并发的 stop、lease watcher、stdout reader、process exit watcher 或 scope finalizer 只会等待同一个预创建 latch。只有 kill/group observation 和 RPC interruption 都被确认后，`settleAgent()` 才会清空 owner/PID；任一项失败或超时都会改走 exact `quarantineAgent()` CAS，把 Agent 记为 `failed`、保留 owner/PID、把 lease 置空并持久化 cleanup diagnostic。这个 tuple 不可过期也不可 claim，fresh supervisor 会在 spawn 前拒绝；当前 supervisor 同时保留 active tombstone。quarantine 自身失败也会保留 tombstone 并暴露 `TerminationError`，不会伪装成功。普通 Store settlement 与 quarantine 都最多尝试三次，scope cleanup 仍然有界。

stdout 只有一个 decoder fiber，继续使用 S01-T06 的 1 MiB、LF-only decoder；decoded frame Queue 固定容量 64，Controller input Queue 固定容量 8，两端都通过 backpressure 限制内存。`stop()` 对 shutdown frame 只做有界 best effort，随后直接进入 terminal kill，因此 child 不读 stdin 或 frame flood 都不能卡住清理。正常 Queue 结束仍会给 stale child 一个真实 EOF。stale hello 在 claim 和 accepted 之前失败，exit `64`；测试 child 会在真正收到 `accepted` 时写 marker，因此不仅 router 调用数保持零，也能直接证明 stale child 没有被接受。

收到 `ready` 后，Supervisor 会先执行一次 exact `AdaptiveStore.heartbeat()` CAS，把 claim 阶段已经消耗的时间归零并取得完整 20 秒 durable lease；只有成功后才激活 routing 和本地 watcher。之后每个匹配 heartbeat 也先执行同一 CAS，成功后才发布到 `Handle.events` 并重建 20 秒 deadline。ready renewal 被拒绝会作为 startup failure 清理，避免 Store lease 先于本地 watchdog 到期。deadline 到期会把同一 generation 结算为 `lost`，然后调用 Core group kill。

`StartInput.router(method, payload, boundIdentity)` 是唯一 child-originated RPC seam。JSON response 会编码为 `rpc.response`；Stream result 会编码为一组 `rpc.event` 和最终 `rpc.end`；typed `RpcError` 变成受控 `rpc.error`。child request ID 在 router fiber 启动前原子注册，同一时间最多允许 32 个；已经完成的 ID 在整个 connection lifetime 也不能重放，每个 generation 最多保留 256 个 ID。`Handle.request()` 复用同一个 identity-bound router，但返回值收窄为 `JsonValue`；router 若返回 lazy Stream，会在已注册的 terminal-owned fiber 内完整消费并返回 JSON array。terminal completion 会中断实际 Stream consumption；退出后的新请求得到 `PROCESS_EXITED`，不会启动 router 或产生 late side effect。无法中断的 fiber 被 quarantine tombstone 保留，但不再让调用方 scope 永久挂起。

stderr 不进入协议 decoder，也不会无界累积。Supervisor 先对最多 64 KiB 原始字节做流式 UTF-8 解码，再遮蔽 credential assignment 和带 userinfo 的 URL，最后按 UTF-8 code point 截断；因此即使 `[REDACTED]` 比原值更长，最终 encoded preview 仍不超过 64 KiB。terminal owner 会有界等待 stderr reader；超时后请求中断，并由幂等 finalizer 立即 flush、sanitize、limit 和 freeze。generic shutdown 不再提前完成 `stderrDone`，迟到 chunk 也不能修改已经暴露的 preview。

隐藏的 `__adaptive-agent` 保留 raw `cmd` 注册，同时在普通 yargs parser、全局 middleware 和 `Heap.start()` 之前有一条窄 dispatch。dispatch 从 command 后截取八个 identity token，动态加载 `AgentEntry`，先调用 `parseArgv()` 做严格顺序和 Schema 校验，再调用 `runStdio()`；缺参、非法 generation 和非法 role 都稳定 exit `64`，不会落入普通 yargs 的 exit `1`。它不构建 AppRuntime、不读取 provider config、不加载 project plugins；当前 role 只 `await context.shutdown`。

## 推荐代码阅读路线

1. 先读 `AdaptiveProcessCommand.environment()`、`agentArgs()`、`options()` 和 `make()`，理解默认拒绝环境与 source/compiled argv 怎样保持同一 production contract。
2. 再读 `AdaptiveProcessSupervisor.StartInput`、`Handle`、`Router` 与 `make()`，确认 public seam 只绑定 child identity，不含 provider/model 选择。
3. 沿 `start()` 阅读 hello、`claimAgent()`、accepted、ready 和 lease watcher，重点检查 claim 之前 router 不可达。
4. 阅读 `runFrames()`、`route()` 与 `finish()`，跟踪 heartbeat CAS、RPC correlation、late-frame terminal gate 和 Store settlement。
5. 阅读 `readFrames()`、`readStderr()` 与 stdin end sentinel，理解 stdout protocol、stderr preview 和 EOF 为什么是三条独立通道。
6. 阅读 `AdaptiveAgentCommand`，确认 hidden CLI 只动态加载 T06 entry，不进入普通 OpenCode runtime bootstrap。
7. 最后读 `process-supervisor.test.ts` 的 real fixture、`.heartbeat`/`.term` readiness marker 和 TestClock deadline，检查测试没有用 fixed sleep 猜 child readiness。

## 术语释义

**Default-deny environment** 的直觉是“没有明确允许就不继承”。工程上，它不是先复制 `process.env` 再删几个已知 key，而是从固定 allowlist 构造全新的 map；本项目还对允许项再执行敏感名字过滤，并设置 `extendEnv: false`。

**Process group** 是操作系统把一个 parent 和其 descendants 放进同一 signal target 的机制。这里 Core spawner 在 POSIX 用 detached child 建立 group，Supervisor 对负 PID 发 signal；因此 Agent 自己启动的 grandchild 也会随 scope close、lease timeout 或 stop 被清理。

**CAS generation claim** 表示“只有 durable generation 仍等于我读到的旧值时，才能原子增加一代并取得 owner lease”。这里 child hello 必须报告 claim 后的新 generation，但 `accepted` 只能在 Store CAS 成功后发送。

**Lease** 是有期限的进程所有权。heartbeat 不是普通日志事件；它必须同时匹配 Agent ID、generation、owner、合法 state 且旧 lease 尚未过期，才可以把 `lease_expires_at` 延长 20 秒。quarantine 的 owner/PID 仍存在但 lease 为 null，它表示 cleanup 未被证实，不属于可过期 lease。

**Out-of-band readiness marker** 是测试用 OS 文件事件证明 child 已到达某个状态，而不是等待固定毫秒数再猜。force-kill 测试让 SIGTERM handler 写 `.term`，测试观察文件存在后才推进明确的三秒产品 deadline。

## 测试看护逻辑

| 风险                                         | 测试方法                                                                              | 关键断言                                                                                         | 证明范围                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| hidden argv 非法                             | 真实 source entry subprocess 分别缺参、传非法 generation 和非法 role                  | 三种情况都 exit `64`                                                                             | early hidden dispatch 绕过普通 yargs fail/middleware                       |
| Controller secret 被 child 继承              | 纯检查最终 env map，并在 Linux 读取真实 hidden child `/proc/<pid>/environ`            | seeded names 和 values 都不存在，安全 flag 可保留                                                | allowlist、`extendEnv: false` 和真实 source hidden command 生效            |
| startup handshake 失败                       | 真实 child 分别制造 hello timeout/EOF、claim 后 ready timeout/EOF                     | start 返回前 child gone；claimed generation 为 `failed` 且 ownership 清空                        | startup cleanup 不依赖外层 scope，failure 不遗留 starting lease            |
| stale child 被接受                           | durable generation 先推进到 1，fixture hello 报 0，并在真正收到 accepted 时写 marker  | exit `64`、accepted marker 不存在、generation 不变、router 调用 0                                | hello identity 和 claim-before-accepted gate 生效                          |
| heartbeat 更新错误 Agent                     | ready 后用文件门闩触发一次 heartbeat                                                  | 只匹配 Agent/generation lease 增加，另一 Agent 完全不变                                          | heartbeat CAS 与 event ordering 生效                                       |
| heartbeat 消失留下进程树                     | child ready 后启动真实 grandchild，不再 heartbeat，推进 20s lease 与 3s kill deadline | 两个 PID 和原 PGID 都消失；Store reason 是 lease expiry                                          | watchdog、group cleanup 和 durable lost settlement 组合生效                |
| direct child 先退出、grandchild 忽略 SIGTERM | parent 按 TERM 正常退出，grandchild 写 `.term` 后继续存活，再推进 2999ms/1ms          | parent 已 gone；2999ms grandchild 仍活，3000ms 后 PID/PGID gone，Store reason 是 Controller stop | Core escalation 以 process group 存活为准，不被 direct-child exit 提前解除 |
| stderr redaction 扩张或跨边界                | 大量短 secret assignment、拆分 emoji bytes、retention boundary secret                 | 最终 encoded bytes 不超过 64 KiB；无 secret 或 replacement corruption                            | bounded capture、streaming decode、redact-then-limit 顺序生效              |
| terminal 原因混淆                            | 分别触发 lease、duplicate RPC、stdout transport、stop 和 code 23 exit                 | Store state、code、reason 精确匹配来源                                                           | durable diagnostics 不把所有终止折叠为 generic failure                     |
| cleanup 不确定却释放 ownership               | 注入 kill defect、RPC interruption timeout 和 quarantine CAS failure                  | owner/PID 保留、lease null、generation 不变；same/fresh supervisor 都不能重启                    | uncertain cleanup fail closed，scope cleanup 仍有界                        |
| ready 消耗旧 lease                           | accepted 后延迟 ready 9 秒，再观察原 claim expiry 与新 deadline                       | start 返回前 Store 已是 running，lease 从 ready 时刻重新获得完整 20 秒                           | durable lease 与 local watchdog 对齐                                       |
| RPC replay 或 lifetime memory 增长           | completed ID replay、连续 257 个 sequential request ID                                | replay 在 barrier 前终止；第 257 个 ID 被拒绝                                                    | connection-lifetime uniqueness 与每 generation 256 上限                    |
| stdin/stdout flood                           | 阻塞 heartbeat consumer 注入 1000 frame；child 停读 stdin 后返回大 response           | upstream pull 停在 frame capacity 附近；input queue 满时 stop 仍完成                             | 两条 Queue 有界且 terminal path 不排在满 Queue 后面                        |
| signal race                                  | probe 返回 alive 后让 group/direct signal 注入 `ESRCH`，另注入 `EPERM`                | ESRCH 成功返回 already gone；EPERM 保持 PermissionDenied                                         | probe-to-signal race 不误报 cleanup failure                                |

这些测试没有证明 provider/model 可用、ModelPolicy 得到审计执行、具体 role 能完成任务、packaged release binary 已跨平台 smoke，或完整 stderr 已持久化。它们证明的是 T07 的 command、hidden source entry、process ownership 和 kill lifecycle；gateway 属于 S01-T08，Controller/packaged integration 属于 S01-T09 及发布验证。

## 亲手验证

从 OpenCode package 运行真实 supervisor 测试、协议回归与类型检查：

```bash
cd packages/opencode
bun test test/adaptive/process-supervisor.test.ts
bun test test/adaptive/process-protocol.test.ts
bun typecheck
```

预期观察：focused supervisor 文件的 39 个 case 全部通过，四个 startup failure case 在返回前完成 cleanup，invalid hidden subprocess 都为 exit `64`，uncertain cleanup 保持 quarantine ownership，ready renewal 与 watcher deadline 对齐，RPC replay/flood 被有界拒绝，stderr preview 在 terminal completion 前冻结，silent/mixed-group case 结束后 PID 与 PGID 都不存在。测试数量是当前实现的运行观测，未来增加 case 时应按实际输出更新。

再验证被复用的 Core spawner、Store 和教程结构：

```bash
cd packages/core
bun test test/effect/cross-spawn-spawner.test.ts test/adaptive/store.test.ts

cd ../../script
bun test adaptive-tutorial-check.test.ts
```

若 child 没有 ready，先检查严格 argv 和 hello generation；若 lease 不更新，检查 Store owner/generation 和当前 TestClock；若 stop 后还有进程，先记录 child PID 的 PGID/SID，再检查 command 是否保留 detached 与三秒 force deadline。

## 当前边界与下一步

T07 的 production hidden role 刻意只等待 `shutdown`。它不会调用 `model.stream` 或 `process.complete`，也不读取 prompt、provider config、credential、plugin 或 Controller memory。S01-T08 会实现 audited Model Gateway，并把 `StartInput.router` 的 `model.stream` 分支接到固定 ModelPolicy、Manifest 和 request audit；它不能放宽 child env 或绕过 bound identity。

S01-T09 会负责 Controller bootstrap、实际 role loop 和 CLI runtime isolation，并把 Supervisor node 加入完整 AppRuntime graph。本任务的 `Handle.request()` 不是反向 child RPC，也不是临时模型通道；后续只能复用同一个 identity-bound router seam。完整 stderr blob、quota 和更长期恢复策略由后续 hardening tasks 接手。

如果后续代码在 claim 前发送 accepted、让 stale frame 进入 router、继承 provider env、为每个角色新增 process wrapper，或只 kill direct child，都会破坏本任务建立的 generation/credential/process-group 边界，应由本文件的真实进程测试继续阻止。
