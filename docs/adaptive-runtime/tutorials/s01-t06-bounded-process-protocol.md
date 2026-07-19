# S01-T06：有界 Agent 进程协议

## 先说结论

S01-T06 为独立 Agent 子进程交付了一条窄而有界的 stdio 契约。`AgentProcessProtocol` 用 Effect Schema 定义 Controller 与 child 之间允许出现的消息，编码器只生成一条 UTF-8 JSON line，增量解码器只接受 LF 结尾并把单帧上限固定为 `1_048_576` encoded bytes。`AgentEntry` 则从严格 argv 中验证 Task、Agent、generation 与 role，完成 hello/accepted/ready handshake、heartbeat 和最多 32 个并发 RPC 的相关性管理。

本任务没有创建 supervisor、隐藏 CLI command、Controller router、Model Gateway 或具体角色实现，也没有把 provider、model、credential、prompt history 或任意 Controller state 放进 child 环境。真实进程的启动、credential scrubbing 与 durable generation 校验由 S01-T07 接手；模型调用的审计执行路径由 S01-T08 接手。

## 它在当前 Milestone 中的位置

S01-T01 已经定义严格的 `AdaptiveTask.ID`、`AgentID` 与 `Role`，S01-T03 提供 durable Task/Agent generation，S01-T05 提供模型请求审计。本任务只把后续独立进程必须使用的身份和两种 RPC method 收窄为 wire contract，让短上下文 Agent 不需要继承 Controller 的内存、credential 或 transcript。

```text
S01-T01 strict Adaptive IDs and roles
  → S01-T06 bounded child process protocol and entry loop
  → S01-T07 process supervision and credential scrubbing
  → S01-T08 audited model gateway execution
```

这条边界服务恢复与模型一致性：generation 必须来自 argv 并在 hello 中原样报告，后续 supervisor 才能在接受进程前与 durable Store 比对；child 只能请求 `model.stream` 与 `process.complete`，因此不能自行选择 provider/model 或绕开 Controller 的审计路径。只有 `process.complete` 得到相关响应后 child 才能返回 exit `0`，避免“请求已发出”被误当作“Controller 已确认完成”。

## OpenCode baseline 与复用边界

修改前，OpenCode 的 `src/util/rpc.ts` 为 Worker message 提供了一个轻量 request/result helper。它直接 `JSON.parse` message，pending map 没有容量上限，也没有协议版本、Schema、frame byte limit、增量 stdio framing、heartbeat、process identity 或退出语义。该 helper 适合同一进程控制下的 Worker，但不能直接作为不受信任 child stdout/stdin 的边界。

本任务直接复用 `@opencode-ai/schema/adaptive-task` 的 ID 与 role Schema，因而没有复制 ULID prefix 或角色枚举；同时遵循 OpenCode 模块的 self-reexport 形式，让消费者使用 `AgentProcessProtocol.*` 与 `AgentEntry.*`。JSON 结构验证使用 Effect Schema，测试使用 Bun test 与内存 transport，没有引入新的 runtime dependency。

复用边界保持明确：旧 `Rpc` helper 的 API 和语义没有修改，新协议也没有借用 Session prompt、provider auth、Config environment 或 Controller Store。`stdioTransport()` 只连接 Bun stdin/stdout；身份解析只查看传入 argv 的四个固定 flag，额外的 provider 或 credential 参数会在发送 hello 之前得到 exit `64`。

## 最终实现

`protocol.ts` 定义了两个方向的 closed union。Child outbound 只有 `hello`、`ready`、`heartbeat`、`rpc.request` 与 `rpc.cancel`；Controller inbound 只有 `accepted`、四种 RPC delivery frame 与 `shutdown`。所有对象都要求 `v: 1`，hello 复用严格 Adaptive ID/role，generation 是 nonnegative safe integer，`heartbeatMs` 是 positive safe integer，extra property 和未知 type 都会失败。

`encode()` 先校验对象，再用 UTF-8 编码 `JSON.stringify(frame) + "\n"`。`MAX_ENCODED_FRAME_BYTES` 包含最后一个 LF，因此 JSON body 最多占 `1_048_575` bytes。`Decoder` 预分配固定容量 buffer，逐 byte 查找 LF，可以接收任意 chunk boundary、一次多帧以及拆在多个 chunk 中的 multibyte UTF-8。协议只接受 LF：bare CR 和 CRLF 都以 `INVALID_NEWLINE` 拒绝，避免不同平台 normalization 产生两种 frame 解释。错误只报告稳定 code/message，不拼接原始 invalid payload。

`AgentEntry.run()` 的注入面只有 argv、byte transport、clock、ID generator 与 role loop。argv 必须严格采用以下顺序，不能增加第五种业务输入：

```text
--task-id <AdaptiveTask.ID>
--agent-id <AdaptiveTask.AgentID>
--generation <nonnegative safe integer>
--role <AdaptiveTask.Role>
```

一次正常控制流如下：

```text
validated argv identity
  → child hello
  → Controller accepted within 10 seconds
  → child ready + heartbeat interval
  → role calls model.stream / process.complete through bounded RpcClient
  → Controller rpc.event / response / end / error correlation
  → acknowledged process.complete
  → cleanup reader and timers
  → exit 0
```

握手前收到非 `accepted` frame、版本错误、Schema 错误、timeout、重复 accepted、未知 request correlation 或 completion 前 shutdown 都走 protocol/config exit `64`。role callback 或其他内部 defect 走 exit `70`。`RpcClient` 在发送第 33 个 outstanding call 前同步抛出 sanitized `RPC_LIMIT`，收到 response/end/error 后立即删除 pending entry；stream event 只调用对应 request 的 `onEvent`，不扩大 map。所有退出路径都会 clear heartbeat、reject/clear pending calls 并调用 input iterator 的 `return()`。

`runStdio()` 是供 S01-T07 hidden command 使用的真实入口适配器。它把 Bun stdin/stdout 和 system clock 注入同一 `run()`，默认从 `process.argv.slice(2)` 取得身份参数，并只设置最终 `process.exitCode`。它不读取 credential environment，也不决定如何执行任何 role；后续 command 必须显式提供 `runRole`。

## 推荐代码阅读路线

1. 先读 `AgentProcessProtocol.ChildToController` 与 `ControllerToChild`，确认两个方向允许的消息和 strict Adaptive identity。
2. 再读 `encode()`、`Decoder.push()` 与 `decode()`，理解 encoded-byte limit、LF-only framing、固定 buffer 和单帧 convenience API 怎样共享同一个 codec。
3. 阅读 `RpcClient.request()` 与 `receive()`，跟踪 request ID、32-call 上限、event delivery、terminal cleanup 和 `completeAcknowledged`。
4. 阅读 `parseArgv()`、`waitForAccepted()` 与 `readController()`，观察 config/protocol error 怎样与 role/internal defect 分到 exit `64` 和 `70`。
5. 最后读 `process-protocol.test.ts` 的内存 `AsyncQueue` 与 `FakeClock`，从无 fixed sleep 的测试还原 handshake、heartbeat、shutdown 和 completion acknowledgment。

## 术语释义

**NDJSON frame** 的直觉是“一行一个 JSON 消息”。工程上，本协议使用 UTF-8 JSON body 加一个 LF delimiter；本项目还把 delimiter 算进 frame byte limit，并拒绝 CR/CRLF，所以任意一串 bytes 只有一种切帧方式。

**Incremental decoder** 是能在完整消息尚未到达时保留有限中间状态的解码器。这里 `Decoder` 不假定一次 stdin read 等于一帧，multibyte code point 可以跨 chunk，但未完成 body 永远不能超过固定 buffer。

**Outstanding RPC** 表示已经发送、尚未收到 terminal response/end/error 的调用。`rpc.event` 不是 terminal，因此不会释放 entry；第 33 个调用在写 stdout 之前被拒绝，避免 Controller 不响应时 child 内存持续增长。

**Handshake deadline** 是 hello 之后等待 accepted 的硬上限。这里 deadline 固定为 10 秒并使用注入 clock；测试可以精确推进到 9,999ms 与 10,000ms，不依赖 wall-clock sleep。

**Exit 64 / 70** 沿用常见 sysexits 含义：`64` 表示 protocol 或 argv configuration 不可接受，`70` 表示 child 内部执行失败。`0` 被保留给 Controller 已确认的 `process.complete`，而不是 role callback 单纯 return。

## 测试看护逻辑

| 风险                                 | 测试方法                                             | 关键断言                                               | 证明范围                                             |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| wire object 被宽松接受               | wrong type/extra field/role/ID/generation cases      | 全部得到 sanitized `INVALID_FRAME`                     | Effect Schema closed union 与 Adaptive identity 生效 |
| UTF-16 length 被误作 wire limit      | ASCII exact boundary 与 400,000 个中文字符           | exact `1_048_576` bytes 通过，multibyte oversized 拒绝 | 上限按 UTF-8 bytes 且包含 LF                         |
| chunk boundary 改变内容              | incomplete、多帧与中文 byte split                    | frame 保序，直到 LF 才返回                             | incremental decoder 不依赖 read boundary             |
| 平台 newline normalization 产生歧义  | bare CR 与 CRLF cases                                | 两者都是 `INVALID_NEWLINE`                             | wire newline 只有 LF 一种                            |
| invalid payload 泄漏到错误           | malformed/version/extra field secrets                | error string 不包含原始 secret                         | codec failure 使用稳定摘要                           |
| Controller 挂起导致 pending map 增长 | 32+1 calls                                           | 第 33 个是 typed `RPC_LIMIT`，response 后可补一个      | child pending state 有硬上限                         |
| handshake 永久等待                   | injected `FakeClock` 推进 deadline                   | 9,999ms 未退出，10,000ms exit `64`                     | 10 秒上限确定且 timer 被清理                         |
| 未确认 completion 被当作成功         | completion request 后检查 settled state              | response 前未退出，匹配 response 后 exit `0`           | 成功依赖 Controller acknowledgment                   |
| reader/timer 遗留                    | timeout、wrong frame、success、fault、shutdown paths | `activeCount === 0` 且 iterator `returned`             | 测试覆盖的退出路径执行 cleanup                       |

这些测试没有启动真实 OS child，也没有证明 supervisor 会 scrub environment、durable generation 一定匹配、stdout/stderr 日志已经隔离、Controller router 会审计模型调用，或 provider stream 可用。它们证明的是 credential-free wire/entry contract 本身；真实进程和 Store 组合属于 S01-T07，Model Gateway 与 audit composition 属于 S01-T08。

## 亲手验证

从 OpenCode package 运行唯一 focused protocol 文件和类型检查：

```bash
cd packages/opencode
bun test test/adaptive/process-protocol.test.ts
bun typecheck
```

预期观察：focused file 显示 21 个通过用例、`0 fail`，codec、RPC state 与 child entry loop 三组都通过；typecheck 的 `tsgo --noEmit` 退出码为 `0`。若 newline case 失败，先检查输入是否包含 byte `0x0d`；若 completion case 卡住，检查 Controller response 的 `requestID` 是否等于 child `rpc.request.id`；若 cleanup 断言失败，检查 accepted timeout 或 heartbeat handle 是否在 `finally` 清除。

再从 repository script package 验证教程结构：

```bash
cd script
bun test adaptive-tutorial-check.test.ts
```

预期观察：九个模板章节、中文正文、索引链接和 marker scan 全部通过。上述 21 个 focused case 是当前任务实现的本地运行结果，不是历史 PR 的固定承诺；增加测试时应同步修正这里的观测数字。

## 当前边界与下一步

S01-T06 只定义 child contract 与可注入 entry loop。它不 fork process、不注册 CLI、不从 Store lookup Task/Agent、不决定是否发送 accepted、不 scrub inherited environment、不转发 stderr，也不重启或 kill hung child。S01-T07 会实现 hidden command、supervisor、credential scrubbing、durable generation/lease validation 与真实进程测试，并通过 `runStdio()` 接入本任务。

本任务的 `model.stream` 和 `process.complete` 只是受限 method name 与 correlation mechanism，没有 provider/model route、request admission、stream audit settlement 或 benchmark proof。S01-T08 会让 Controller router 把 `model.stream` 接到同一 ModelPolicy、resolver 与 audit service。若下游绕过这条协议、放宽 argv，或在 acknowledgment 前把 child exit `0`，短上下文恢复与 same-model validity 都失去可信边界；因此这些限制应由后续实现组合，而不是在本层增加 credential 或 Controller state。
