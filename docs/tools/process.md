# Process 与终端工具

Process Host 是每个 Instance 内独立于 Worker 请求生命周期的进程持有者。普通 Pipe 命令、PTY 命令和人工终端使用同一套资源、输入与输出机制。它们不依赖 tmux 或 psmux。

## 执行命令

`bash_run` 启动命令。普通命令默认使用 Pipe；需要真实终端时设置 `tty: true`。两种模式均可持续运行。

```json
{"command":"cargo build","waitMs":1000}
```

- `waitMs` 控制本次调用等待多久，等待结束不终止进程。为 0 时立即返回任务。
- `timeoutMs` 是可选的实际执行期限；达到期限后终止任务。省略时没有这个执行期限。
- `cwd`、`env`、`stdin`、`maxCaptureBytes` 保留 shell 执行契约。
- Pipe 默认在初始输入后关闭 stdin；`keepStdin: true` 保留输入。PTY 可以接受后续终端输入。

结果提供 `task.id`、`task.status`、`termination`、`cursor`、stdout/stderr 与退出信息。使用返回的 cursor 继续读取。长输出可通过返回的 stdoutPath/stderrPath 使用 file_read 读取。

## 读取与输入

```json
{"task":"process-…","cursor":{"seq":0,"stdout":0,"stderr":0},"timeMs":10000}
```

这是 `task_read` 的输入示例。`untilExit: true` 等待终态；否则在新输出可用时返回。各读取者独立维护 cursor，读取不会消耗其他客户端的输出。

`task_input` 接收 task 与原始字符串 input。对于保留 stdin 的 Pipe，可以传入 `eof: true` 关闭输入。

## 持久终端

`task_manage` 支持：

- `{"command":"list"}`：列出当前执行作用域内的进程资源。
- `{"command":"create","cwd":"./"}`：创建持久交互终端，可选 shell。
- `{"command":"close","id":"process-…"}`：终止资源，已保留的输出仍可读取。

`task_inspect` 接收 `{"terminal":"process-…"}`，读取终端当前状态，不消费任务输出。

## 人机协同

同一台 Worker 主机上，通过实例共用的 Worker binary 直接使用：

```bash
devshell-worker terminal list
devshell-worker terminal attach <id>
devshell-worker terminal attach <id> --takeover
```

普通 attach 为观察；`--takeover` 显式取得独占输入。Ctrl+] 退出 Attach 并释放控制权，不终止进程。接管期间模型输入被拒绝，释放后可以继续输入。TUI Sessions 通过 Terminal Stream 使用同一 PTY，进入会话时接管输入。原始 PTY 字节流在连接时的状态恢复之后继续传输。

## 生命周期与作用域

普通 Worker stop/restart 不关闭 Process Host；Instance retire 回收它。旧版本 tmux 会话不转换为新资源，升级前应使用旧版本完成或退出这些会话。

MCP Context 结束不会自动关闭进程。普通调用按 Workspace 作用域访问资源；Stateless 使用独立的无 Workspace 作用域并要求绝对 cwd。Stateless 不创建 Context 或 durable Wait。

当普通 Context 的 bash_run 等待达到 180 秒同步窗口而任务未结束时，Control 可以创建 durable Wait 继续观察。task_read 的同步等待窗口为 120 秒。停止等待与终止进程是两个不同操作。
