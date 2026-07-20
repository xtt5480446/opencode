# S01-T10：Packaged binary smoke 与 G1 验收入口

## 先说结论

本任务把 Stage 1 从“源码测试能够运行”推进到“刚构建出的原生 OpenCode 二进制必须能够运行”。每次本机目标的 release build 在完成原有 `--version` 检查后，都会用该二进制执行 `adaptive doctor --offline --json`；数据库、子进程、工作区、审计表或协议版本任一不正确，整个构建立即失败。

这项交付不调用真实模型，也不替用户接受 G1。它证明 packaged binary 内确实包含 Adaptive CLI、hidden child entry、SQLite foundation 和进程协议；真实 provider、同一模型策略与凭据隔离仍由本任务最后给出的 G1 用户试跑确认。

## 它在当前 Milestone 中的位置

S01-T09 已把 Store、Model Gateway、进程监督和 CLI 串成源码可运行的 Adaptive bootstrap，但源码入口成功不等于发布包成功。Bun compile 可能遗漏入口、资源或运行时行为，因此 S01-T10 是 G1 的最后一道自动化发布门，也是 Stage 2 开始前的用户验收入口。

```text
S01-T01 ... S01-T08 foundation components
  → S01-T09 source CLI / Controller integration
  → S01-T10 packaged binary smoke
  → user accepts G1
  → Stage 2 context reconstruction
```

对短上下文 Agent 的直接价值是确认最底层执行边界已经能随产品发布：Coordinator 将来即使被周期性清空和重建，也能由 packaged Controller 重新启动，而不是只在开发仓的 TypeScript 入口中成立。若这一层失败，后续 Roadmap、Detail Pool 和 Worker 恢复能力都没有可交付的宿主。

## OpenCode baseline 与复用边界

OpenCode baseline 的 `packages/opencode/script/build.ts` 已经负责选择目标平台、调用 `Bun.build`、嵌入必要文件，并对本机目标运行一次 `<binary> --version`。本任务完整保留这条成熟构建链，不复制打包器、不新增另一套 release 命令，也不改变非本机 cross target 的既有产物生成方式。

直接复用的部分包括现有 target loop、`binaryPath`、Bun shell 调用、原有 version smoke，以及 T09 已实现的 `adaptive doctor --offline`。新增逻辑只承担 baseline 没有的语义：构建不能仅证明二进制可启动，还必须证明 Adaptive hidden child、foundation schema 和协议握手可从同一个二进制工作。

smoke runner 没有复用测试用的 `src/index.ts` 或 fake provider。它收到 build loop 刚生成的 binary 路径，并在新的临时工作区直接执行该文件。因此源码测试继续负责细粒度行为，packaged smoke 专门看守“最终交付物是否真的包含并能启动这些能力”，二者没有互相冒充。

Stage 1 全量回归还发现 T09 增加 `--runtime` 后，OpenCode 既有 CLI help snapshot 没有同步。T10 把这项用户可见契约补入原 snapshot；没有另建 Adaptive 专用 help 测试，继续复用 baseline 已有的全命令帮助文本看护机制。

## 最终实现

`build.ts` 在脚本启动时解析 `adaptive-smoke.ts` 的绝对路径。本机目标编译完成后，原有 `<binary> --version` 先运行；只有它成功，构建才调用 `bun adaptive-smoke.ts <binary>`。调用位于同一个 `try` 中，任何非零退出都会沿用 OpenCode 现有 build failure 行为。

`runAdaptiveSmoke()` 每次创建独立的临时根目录，并在其中分开建立 `home` 与 `workspace`。子进程只继承启动二进制所需的 PATH、Windows 系统路径和 locale；父进程中的任意 API key、token、cookie 或配置变量不会直接继承。它还显式设置一次性的 HOME、XDG、SQLite 路径与以下离线开关：

- `OPENCODE_PURE=1`
- `OPENCODE_DISABLE_AUTOUPDATE=1`
- `OPENCODE_DISABLE_AUTOCOMPACT=1`
- `OPENCODE_DISABLE_MODELS_FETCH=1`
- `OPENCODE_DISABLE_PROJECT_CONFIG=1`
- `OPENCODE_AUTH_CONTENT={}`

真实控制流如下：

```text
Bun.build current native target
  → existing <binary> --version smoke
  → adaptive-smoke.ts resolves the binary to an absolute path
  → create disposable HOME / XDG / DB / workspace
  → <binary> adaptive doctor --offline --json
  → wait at most 30 seconds while draining stdout and stderr
  → reject nonzero exit or malformed JSON
  → require mode=offline, four checks=ok, protocol=1
  → remove the complete temporary root in finally
  → allow build to continue
```

30 秒到期时 runner 会终止完整进程树再进入清理：POSIX 先暂停 outer doctor，枚举并暂停后代，再从叶子到根发送 `SIGKILL`；Windows 使用 `taskkill /T /F`。stdout 与 stderr 各自最多保留 `64 KiB`，任一超限也会触发同一进程树终止，避免坏产物通过持续日志耗尽构建机内存。

输出校验使用明确字段值，而不是只判断 JSON 可解析；缺字段、失败状态、错误 mode 和未来不兼容的协议版本都会 fail closed。成功时只打印协议版本，不把临时 HOME、环境内容或审计数据写进构建日志。

G1 acceptance ledger 记录本次 build、日期和本地产物位置，但 Result 保持 `pending`。只有用户完成真实模型命令并检查 evidence export 后，才能把它改为 `accepted`；代码或 Agent 不能自我批准这一 gate。

## 推荐代码阅读路线

1. 先读 `packages/opencode/script/build.ts` 中 `adaptiveSmokeScript` 和本机 target smoke，确认 Adaptive 检查使用的就是刚生成的 `binaryPath`。
2. 再读 `runAdaptiveSmoke()`，理解一次性目录、环境白名单、命令参数、30 秒上限和 `finally` 清理如何组成一个完整边界。
3. 阅读 `validateAdaptiveDoctor()`，查看 offline mode、四个 foundation check 与 protocol 的精确断言。
4. 阅读 `packages/opencode/script/adaptive-smoke.test.ts`，观察成功、错误输出、非零退出、环境泄漏与超时怎样由真实 Bun subprocess 验证。
5. 再看 `packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap`，确认 baseline 帮助文本正式包含默认 `baseline` 的 runtime 选择。
6. 最后看 `packages/opencode/test/cli/adaptive-process.test.ts` 的 build-gate 断言，以及 G1 acceptance ledger 中仍由用户控制的 Result。

按这条路线阅读可以先建立发布链的整体认识，再深入具体故障分支；不需要先理解 Bun compile 的全部内部实现，也不需要重新阅读前九个任务的设计稿。

## 术语释义

**Packaged binary smoke** 直觉上是“对准备交付的那个文件做一次短而关键的体检”。工程上它运行编译产物而非源码入口，只验证发布最容易遗漏且成本可控的主链。本任务检查 CLI dispatch、hidden child、数据库、工作区、审计和 protocol，不执行真实模型任务。

**Hermetic environment** 指一次运行尽量不读取开发者机器的隐式状态。本任务用独立 HOME、XDG、DB、workspace、空 auth 和环境白名单建立近似 hermetic 的 offline doctor，使本地已有配置、API key 或项目文件不能把坏产物“碰巧救活”。

**Fail closed** 表示无法证明正确时就让构建失败。doctor 输出缺一个字段、返回未知协议、超时或产生畸形 JSON 都不会被当成可忽略警告；这避免发布流程在证据不足时继续产生看似成功的包。

**Protocol version** 是 Controller 与 Adaptive child 共同理解的消息契约版本。`protocol=1` 不只是展示字段，它证明 packaged parent 能启动 packaged hidden child，双方完成当前版本的 handshake，而不是只加载了一个 CLI command。

## 测试看护逻辑

| 风险                           | 测试方法                         | 关键断言                                                        | 证明范围                          |
| ------------------------------ | -------------------------------- | --------------------------------------------------------------- | --------------------------------- |
| build 忘记调用 Adaptive smoke  | 读取真实 `build.ts`              | 定义 runner 路径并在 `binaryPath` 上调用                        | 发布脚本存在强制 gate             |
| 新 runtime 没进入 CLI help     | 运行既有全命令 help snapshot     | `run --help` 包含 baseline/adaptive 选择和默认值                | T09 用户界面契约不再漂移          |
| doctor 伪成功或字段不完整      | 对每个字段注入错误值             | mode、四项 check、protocol 全部精确匹配                         | 输出契约 fail closed              |
| 输出不是 JSON                  | 输入畸形 stdout                  | 返回包含捕获输出的明确错误                                      | 构建日志可定位解析失败            |
| binary 非零退出                | 启动真实失败 fixture             | 保留 exit code 与 stderr                                        | 子进程故障不会被吞掉              |
| 父环境或本机配置污染 smoke     | fixture 检查 argv、cwd 和 env    | secret 不继承，HOME/XDG/DB/flags 全隔离                         | offline 自检不依赖用户机器状态    |
| doctor 永久挂起                | fixture 延迟超过测试上限         | 到期杀完整进程树、明确 timeout、目录清空                        | build 有 30 秒生产上限            |
| detached hidden child 成为孤儿 | fixture 启动 detached grandchild | timeout 后 PID 不再存活                                         | 外层 circuit breaker 不遗留后代   |
| 坏 binary 持续刷日志           | 分别 flood stdout 和 stderr      | 超过 `64 KiB` 后终止进程树并返回明确错误                        | 构建机内存不会随输出无界增长      |
| 临时状态污染后续 build         | 成功与超时路径检查目录           | 运行后临时父目录为空                                            | `finally` 清理覆盖正常和超时路径  |
| 源码能跑但产物缺入口           | 执行真实单平台 build             | native binary 输出 `Adaptive packaged smoke passed: protocol=1` | 当前 Linux x64 产物主链真实可运行 |

这些测试不证明真实 provider 凭据有效、模型输出质量满足要求，也不证明所有 cross target 都已在当前机器执行。Stage 6 会扩展完整平台矩阵和更长 packaged workflow；G1 用户试跑负责本阶段真实模型与 evidence export。

## 亲手验证

从 OpenCode package 运行 focused unit tests：

```bash
cd packages/opencode
bun test script/adaptive-smoke.test.ts
bun test test/cli/adaptive-process.test.ts --test-name-pattern "release build gates"
```

预期分别看到 `10 pass / 0 fail` 和 `1 pass / 0 fail`。随后构建当前平台产物：

```bash
cd packages/opencode
bun run build --single --skip-embed-web-ui
```

2026-07-20 的 Linux x64 验证产物位于 `packages/opencode/dist/opencode-linux-x64/bin/opencode`，构建末尾依次输出 version smoke 成功和 `Adaptive packaged smoke passed: protocol=1`。若前者失败，先检查 Bun compile/动态库；若后者失败，错误会明确区分 timeout、exit code、stderr、JSON 或具体 doctor 字段。

最终 G1 不能只跑 offline smoke。使用同一个真实短上下文模型执行 acceptance ledger 对应的两次 baseline、一次 live doctor 和一次 export，并检查 `model-requests.jsonl` 只有一个模型 identity、process environment 没有 credential-like 值，再由用户记录验收结论。

## 当前边界与下一步

S01-T10 只为当前本机 native target 运行 offline packaged smoke；cross-compiled target 无法在本机直接执行，完整 Linux、macOS 和 Windows 发布矩阵属于后续商业 hardening。当前 smoke 也不会联网、调用模型或模拟长任务，因此不能替代 G1 的真实 provider 验收和未来的长时间 soak。

在用户把 G1 明确标为 `accepted` 之前，Stage 2 不应开始。验收失败应回到 Stage 1 修正 packaged execution、baseline parity、模型审计或凭据隔离，不允许用后续 issue 推迟。验收通过后，Stage 2 才会在这个已验证的进程与二进制边界上实现 ContextManifest 重建、Coordinator/Worker 重启和短上下文恢复。

后续修改若移除 build 中的 smoke 调用、改为运行 `src/index.ts`、继承父进程全部环境、放宽 doctor 字段或把 timeout 变成警告，都会破坏本任务建立的发布保证，现有单元测试、build-gate test 和真实单平台 build 应共同阻止这些回归。
