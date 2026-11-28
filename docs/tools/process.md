# Process 与终端工具

Process Host 是每个 Instance 内独立于 Worker 请求生命周期的进程持有者。普通 Pipe 命令、PTY 命令和持久交互终端使用同一套统一的 4 个工具契约：`bash_run`、`task_input`、`task_inspect`、`task_manage`。它们不依赖 tmux 或 psmux。

## 执行命令：`bash_run`

`bash_run` 启动命令，输入为 `{ command, cwd?, env?, pty?, waitMs? }`：

```json
{"command":"cargo build","waitMs":1000}
```

- `waitMs` 控制本次调用同步等待多久，默认 `10000`（10 秒）；等待结束不终止进程。为 `0` 时立即返回运行中的任务。
- 启动后台常驻服务时不要用 `&`（shell 退出时会清理整个进程组），请前台运行并传入较短的 `waitMs`，通过返回的 `task` 与 `task_manage(command="close")` 管理生命周期。
- 若 `bash_run` 在首次返回任务 ID 前被显式取消（cancel），Worker 会终止对应进程组以避免遗留孤儿进程。
- `pty` 为可选布尔值（默认 `false`）：普通命令默认使用 Pipe（非交互式）；需要真实终端或后续通过 `task_input` 发送交互输入时设置 `pty: true`（默认尺寸 `120×36`）。
- `cwd` 与 `env` 保留 shell 执行契约。
- `timeoutMs`、`maxCaptureBytes`、`stdin`、`keepStdin`、`tty` 已从 `bash_run` 契约移除。

Worker 内部仍返回完整的 `BashRunOutput`；MCP 与 Agent 的模型结果使用精简投影：

- 正常完成：`exitCode`、`durationMs`、非空 `stdout` / `stderr`。例如 `{"exitCode":0,"durationMs":12,"stdout":"hello\n"}`。
- 运行中：`task` 是任务 ID 字符串，`cursor` 是不透明续读位置，可直接传给 `task_input`。正常运行没有 `exitCode` 或异常 `termination`。人工接管、全屏状态和 durable Wait 分离仅在实际发生时返回 `humanControl`、`alternateScreen`、`detached`（分别为 true）。
- 异常终止：保留 `termination`（例如 `signaled`、`timeout`）及可用的 `termSignal`；不重复返回 `timedOut`。正常等待原因和输入参数回显不再向模型展示。
- 输出不完整：保留对应 `stdoutTruncated` / `stderrTruncated`、字节计数、可用恢复路径和任务续读引用。若恢复 Artifact 本身也不完整，以 `stdoutArtifactTruncated` / `stderrArtifactTruncated` 标识；原始 Artifact 元数据不暴露给模型。恢复路径仍使用 `file_read` 读取。
- 以上仅影响 `bash_run` 和 `task_input` 的模型结果；`task_manage(command="create")` 仍返回原来的任务描述符，Worker、审计、MCP App 和底层执行协议不变。

## 交互与轮询：`task_input`

`task_input` 合并了原先的 `task_read` 与 `task_input`，采用与 Codex `write_stdin` 一致的统一接口，输入为 `{ task, input?, cursor?, waitMs?, untilExit? }`：

```json
{"task":"process-…","cursor":"tc2_…","waitMs":5000}
```

- 省略 `input` 或传入 `""` 时只轮询/等待新输出而不写入输入；此时可用于 Pipe 命令或 PTY 命令。
- 传入非空 `input` 时向任务写入原始字符串（TUI/ConPTY 回车推荐 `\r`，普通行 shell 可用 `\n`，Ctrl+C 为 `\u0003`，Ctrl+D 为 `\u0004`）；要求目标为 `pty: true` 启动的 PTY 任务或 `task_manage` 创建的持久终端，非 PTY 的 Pipe 命令会拒绝非空输入。
- `cursor` 为绑定到单个任务的不透明字符串，只能和返回它的任务 ID 一起使用（来自 `bash_run`、`task_manage(command="create")` 或上一次 `task_input`）。写入非空 `input` 但省略 `cursor` 时，默认从当前输出尾部开始采集，避免重放整个终端历史；纯读省略 `cursor` 时会从第 0 字节重放全部历史，因此轮询时应始终传回上次返回的 `cursor`。
- `waitMs` 控制等待时长，默认 `5000`（5 秒）；未指定 `untilExit: true` 时在收到新输出后会短暂聚合（150ms，且总聚合延长不超过 600ms 防止持续日志流拖满 `waitMs`）以减少流式输出轮询风暴。
- `untilExit: true` 等待非持久任务退出（不可用于持久交互终端，因为持久终端退出会自动重启）；否则在新输出可用或达到 `waitMs` 时返回。
- 若向已退出的 PTY 任务写入非空 `input`，会返回 `process.exited`（仍可省略 `input` 读取已保留输出）。
- 原 `eof` 与 `timeMs` 参数已移除，返回结构同为 `BashRunOutput`。

## 终端快照：`task_inspect`

`task_inspect` 接收 `{"task":"process-…"}`（参数名已从 `terminal` 统一为 `task`），返回干净的当前可见终端屏幕快照（尺寸、光标与可见文本行，不再包含 `formatted` / `restore` 等转义恢复负载），不消费任务输出。仅适用于 PTY 任务与持久终端。

## 资源与持久终端管理：`task_manage`

`task_manage` 使用扁平对象 `{ command, task?, name?, cwd?, shell?, cols?, rows? }`，支持：

- `{"command":"list"}`：列出当前执行作用域内的进程与终端摘要（运行中任务与持久终端置顶，已完成历史最多保留最近 10 条），包含 `id`、`kind`、`persistent`、`pty`、`state`、可选 `name` / `cwd` / `command`、`humanControl`、可选 `exitCode`、`createdAtMs`。
- `{"command":"create","name":"…","cwd":"./"}`：创建一个持久人机协同交互终端（可选 `name`、`cwd`、`shell`、`cols` 默认 `120`、`rows` 默认 `36`），同时返回初始 `cursor`。持久终端在运行期间不会被自动回收，shell 退出后会自动重启（带退避与瞬崩熔断），并与 `devshell-worker terminal` 协同工作。
- `{"command":"close","task":"process-…"}`：请求终止对应任务或持久终端，返回 `taskId`、`killRequested: true` 和本次观察到的 `state`；如果 `state` 仍为 `running`，表示终止请求已接受但尚未观察到退出，应使用 `task_manage(command="list")` 轮询状态，而不是将其视为已关闭。已保留的输出仍可读。

`task_input` 的纯轮询和 `task_manage(command="list")` 都不写入进程。MCP annotations 只能标注整个工具，因此这两个工具仍按可能写入或终止进程来标注；客户端可能对只读调用也要求审批。`task_inspect` 本身标注为只读，但只返回 PTY 屏幕。

## 人机协同

支持两种 CLI 入口接入同一套 Process Host 终端资源：

- **Control CLI（跨 `local` / `ssh` / `docker` / `podman` / `reverse` 实例统一入口）**：

```bash
devshell terminal list <instance> [--all]                        # 列出终端与任务（全局支持 --json）
devshell terminal create <instance> --workspace . --name dev     # 创建持久终端并立即接管（支持 --detach / --ephemeral / --cwd / --shell / --command / --cols / --rows）
devshell terminal attach <instance> [name|short-id] [--takeover] # 观察模式或 --takeover 接管（仅 1 个活跃 PTY 时可省略目标；支持只读观察 [pipe] 非 PTY 后台任务）
devshell terminal inspect <instance> [name|short-id]             # 不进入交互模式查看当前 PTY 可见屏幕（全局支持 --json）
devshell terminal close <instance> [name|short-id]               # 终止任务或持久终端（全局支持 --json，同样支持 [pipe] 任务）
```

- **同机 Worker binary（直接连接本机实例）**：

```bash
devshell-worker terminal list                                    # TTY 下默认表格展示，--all 看历史，--json 输出原始 JSON
devshell-worker terminal create --workspace . --name dev         # 人工创建持久终端并立即接管（--detach 后台创建，--stateless 绑定无 workspace 作用域）
devshell-worker terminal attach [name|short-id]                  # 观察模式（仅 1 个活跃 PTY 时可省略目标）
devshell-worker terminal attach [name|short-id] --takeover       # 显式取得独占输入
devshell-worker terminal inspect <name|short-id>                 # 不进入交互模式查看当前 PTY 可见屏幕
devshell-worker terminal close <name|short-id>                   # 终止任务或持久终端
```

双向接管与主动交接闭环：
- **模型创建 → 人类接管**：模型通过 `bash_run(pty: true)` 或 `task_manage(command="create")` 启动后，人类用 `attach` 观察或 `--takeover` 接管。
- **人类创建 → 模型接管**：人类用 `devshell terminal create <instance> --workspace <path> --name <name>`（或 `devshell-worker terminal create`）创建持久终端并先完成登录/MFA/环境初始化，随后按 `Ctrl+] t` 释放控制权退回观察态（或按 `Ctrl+]` / `Ctrl+] d` 脱离），同 Workspace 下的模型即可通过 `task_manage(command="list")`、`task_inspect` 与 `task_input` 直接接手。
- **主动交接通知（`[Terminal handoff]`）**：无论人类通过 `devshell terminal`、`devshell-worker terminal` 还是 TUI `Sessions` 释放控制权，只要运行中 PTY 的 `humanControl` 从 `true` 切回 `false`，Worker 都会推送 `terminal.control` 事件，并向匹配作用域的活跃 Context 投递 `[Terminal handoff]` Comment，主动告知模型当前终端 ID/名称、状态及最新尺寸。
- **尺寸自动恢复**：人类在接管期间调整了终端尺寸后，释放控制权时 Process Host 会自动将 PTY 恢复到接管前的原始尺寸。

Attach 会话快捷键与行为：
- 按下 `Ctrl+]` 后终端标题栏（OSC 0）立即显示等待提示（`Ctrl+] waiting: d detach · t toggle · ] send ^]`），和弦超时约 `800ms`：
  - `Ctrl+]`（单独按，等待约 `800ms` 超时）或 `Ctrl+] d`：脱离 Attach 并释放控制权，不终止进程。
  - `Ctrl+] t`：在会话内实时切换 **观察（OBSERVE）↔ 接管（CONTROL）**，终端标题栏（OSC 0）实时提示当前模式；接管期间模型 `task_input` 写入被拒绝，释放后可立即继续输入。
  - `Ctrl+] ]`：在接管模式下向远端 PTY 发送字面 `Ctrl+]`（`0x1d`）。
- 遇到输出突增触发 `stream.gap` 时自动重连并恢复屏幕快照。
- `devshell terminal` 与 TUI `Sessions` 同样展示非 PTY（`[pipe]`）后台任务，并支持只读观察实时输出与关闭终止（不支持接管输入与屏幕快照）。
- TUI `Sessions` 面板通过 Terminal Stream 使用同一 PTY，常用快捷键：`Enter` 进入接管控制、`o` 进入只读观察、`t` 在观察模式内接管控制、`Alt+o` 在 `[CONTROL]` 模式下就地释放控制权退回 `[OBSERVE]`、`n` 打开名称输入提示并创建持久终端、`x` 关闭任务/终端、`r` 刷新列表。原始 PTY 字节流在连接时的状态恢复之后继续传输。

## 生命周期与作用域

普通 Worker stop/restart 不关闭 Process Host；Instance retire 回收它。旧版本 tmux 会话不转换为新资源，升级前应使用旧版本完成或退出这些会话。

升级到 Process Host 协议 v2 前，先用旧版本结束现有任务并停止旧 Process Host；只重启 Worker 不会替换 Host。v2 的输出边界和 cursor 不与 v1 混用。

MCP Context 结束不会自动关闭进程。同一 Instance、同一 Workspace 下，进程是共享资源，不归创建它的 Context 或模型独占：其他具有相应权限的调用者也可列出、读取、写入或关闭该任务。人工接管会阻止模型写入，但模型之间没有输入租约；并行使用时请协调输入，或各自创建终端。

Stateless 使用同一 Instance 下独立的无 Workspace 共享作用域，并要求在 `bash_run` 与 `task_manage(command="create")` 中提供绝对 `cwd`。Stateless 不创建 Context 或 durable Wait。

当普通 Context 的 `bash_run` 同步等待达到 180 秒（`WAIT_HANDOFF_MS = 180000`）而任务仍未结束时，Control 创建 durable Wait（`detached: true`）继续观察，底层 task 继续运行；`task_input` 的同步等待窗口为 120 秒。停止等待与终止进程是两个不同操作。
