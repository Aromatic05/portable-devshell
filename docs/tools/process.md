# Process 与终端工具

Process Host 是每个 Instance 内独立于 Worker 请求生命周期的进程持有者。普通 Pipe 命令、PTY 命令和持久交互终端使用同一套统一的 4 个工具契约：`bash_run`、`task_input`、`task_inspect`、`task_manage`。它们不依赖 tmux 或 psmux。

## 执行命令：`bash_run`

`bash_run` 启动命令，输入为 `{ command, cwd?, env?, pty?, waitMs? }`：

```json
{"command":"cargo build","waitMs":1000}
```

- `waitMs` 控制本次调用同步等待多久，默认 `10000`（10 秒）；等待结束不终止进程。为 `0` 时立即返回运行中的任务。
- 启动后台常驻服务时不要用 `&`（shell 退出时会清理整个进程组），请前台运行并传入较短的 `waitMs`，通过返回的 `task.id` 与 `task_manage(command="close")` 管理生命周期。
- 若 `bash_run` 在首次返回 `task.id` 前被显式取消（cancel），Worker 会终止对应进程组以避免遗留孤儿进程。
- `pty` 为可选布尔值（默认 `false`）：普通命令默认使用 Pipe（非交互式）；需要真实终端或后续通过 `task_input` 发送交互输入时设置 `pty: true`（默认尺寸 `120×36`）。
- `cwd` 与 `env` 保留 shell 执行契约。
- `timeoutMs`、`maxCaptureBytes`、`stdin`、`keepStdin`、`tty` 已从 `bash_run` 契约移除。

结果返回 `BashRunOutput`，包含 `task.id`、`task.status`、`task.pty`（人工接管期间附带 `task.humanControl: true`）、`termination`、不透明字符串 `cursor`、`stdout` / `stderr`、字节计数与截断标志、退出码 / 信号与等待信息。长输出可通过返回的 `stdoutPath` / `stderrPath`（`/.devshell/tool-results/<id>/stdout|stderr`）使用 `file_read` 读取。

## 交互与轮询：`task_input`

`task_input` 合并了原先的 `task_read` 与 `task_input`，采用与 Codex `write_stdin` 一致的统一接口，输入为 `{ task, input?, cursor?, waitMs?, untilExit? }`：

```json
{"task":"process-…","cursor":"tc2_…","waitMs":5000}
```

- 省略 `input` 或传入 `""` 时只轮询/等待新输出而不写入输入；此时可用于 Pipe 命令或 PTY 命令。
- 传入非空 `input` 时向任务写入原始字符串（TUI/ConPTY 回车推荐 `\r`，普通行 shell 可用 `\n`，Ctrl+C 为 `\u0003`，Ctrl+D 为 `\u0004`）；要求目标为 `pty: true` 启动的 PTY 任务或 `task_manage` 创建的持久终端，非 PTY 的 Pipe 命令会拒绝非空输入。
- `cursor` 为绑定到单个任务的不透明字符串，只能和返回它的任务 ID 一起使用（来自 `bash_run`、`task_manage(command="create")` 或上一次 `task_input`）。写入非空 `input` 但省略 `cursor` 时，默认从当前输出尾部开始采集，避免重放整个终端历史；纯读省略 `cursor` 时从头读取。
- `waitMs` 控制等待时长，默认 `5000`（5 秒）；未指定 `untilExit: true` 时在收到新输出后会短暂聚合（150ms）以减少流式输出轮询风暴。
- `untilExit: true` 等待非持久任务退出（不可用于持久交互终端，因为持久终端退出会自动重启）；否则在新输出可用或达到 `waitMs` 时返回。
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

同一台 Worker 主机上，通过实例共用的 Worker binary 直接使用：

```bash
devshell-worker terminal list
devshell-worker terminal attach <id>
devshell-worker terminal attach <id> --takeover
```

普通 attach 为观察；`--takeover` 显式取得独占输入。Ctrl+] 退出 Attach 并释放控制权，不终止进程。接管期间模型 `task_input` 写入被拒绝，释放后可以继续输入。TUI Sessions 通过 Terminal Stream 使用同一 PTY，进入会话时接管输入。原始 PTY 字节流在连接时的状态恢复之后继续传输。

## 生命周期与作用域

普通 Worker stop/restart 不关闭 Process Host；Instance retire 回收它。旧版本 tmux 会话不转换为新资源，升级前应使用旧版本完成或退出这些会话。

升级到 Process Host 协议 v2 前，先用旧版本结束现有任务并停止旧 Process Host；只重启 Worker 不会替换 Host。v2 的输出边界和 cursor 不与 v1 混用。

MCP Context 结束不会自动关闭进程。普通调用按 Workspace 作用域访问资源；Stateless 使用独立的无 Workspace 作用域并要求在 `bash_run` 与 `task_manage(command="create")` 中提供绝对 `cwd`。Stateless 不创建 Context 或 durable Wait。

当普通 Context 的 `bash_run` 同步等待达到 180 秒（`WAIT_HANDOFF_MS = 180000`）而任务仍未结束时，Control 创建 durable Wait（`detached: true`）继续观察，底层 task 继续运行；`task_input` 的同步等待窗口为 120 秒。停止等待与终止进程是两个不同操作。
