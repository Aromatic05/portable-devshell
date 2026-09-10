# Testspace

Testspace 是 portable-devshell 自带的**隔离真实运行环境**。它启动真正的 Control、local worker、Reverse worker、两个 MCP endpoint、Web UI 和活动 connector，用于人工观察完整产品行为。

它不是 unit test 的替代品，也不应该使用真实 `~/.devshell`。

## 常用命令

```bash
pnpm testspace
pnpm testspace status
pnpm testspace tui
pnpm testspace web
pnpm testspace smoke
pnpm testspace stop
```

其他开发入口：

```bash
pnpm testspace web-smoke
pnpm testspace comment-smoke
pnpm testspace exec -- <command...>
```

`pnpm testspace` 等价于 start。默认会先执行项目 build 和 `test:prepare`；开发者已经明确准备好构建产物时可以使用 `--skip-build`。

活动 connector 默认周期是 2 秒，可通过：

```bash
pnpm testspace -- --interval-ms <250..60000>
```

调整。

## 启动内容

Testspace 创建两个真实 instance：

```text
testspace-local     local provider
testspace-reverse   reverse provider
```

两者都使用独立 Testspace 配置、workspace 和 runtime。MCP/Web 会在可用端口附近分配 listener；当前首选起点为：

```text
MCP  18790
Web  18791
```

端口冲突时会自动选择其他空闲端口，因此脚本/人工验收都应该读取 Testspace 输出或 `status`，不要硬编码端口。

Testspace instance 故意启用较宽的开发策略：

```text
MCP auth        none
approval        allow
security.mode   workspace
groups          file,bash,artifact,tmux,todo,workspace,instance
capabilities    read,write,execute,manage
```

这是隔离测试环境，不是生产配置模板。

## 隔离目录

默认 root：

```text
<repo>/.testspace
```

内部会创建独立的：

```text
HOME
XDG_CONFIG_HOME
XDG_DATA_HOME
XDG_CACHE_HOME
XDG_RUNTIME_DIR
Control config/state
local workspace
reverse workspace
reverse worker home/runtime
connector logs/health/state
```

因此正常 Testspace 不读取或修改用户真实：

```text
~/.devshell
~/.config/agents
普通项目 workspace
```

worker internal 环境变量在启动前也会被清理，避免外部运行环境把一个普通 Testspace worker 伪装成另一个 instance/security/workspace。

## 自定义 root

可以设置：

```bash
DEVSHELL_TESTSPACE_ROOT=/absolute/testspace pnpm testspace
```

安全规则：

* 不能为空；
* 不能是文件系统根；
* 不能包含 portable-devshell 仓库本身；
* 已存在的自定义目录必须带 Testspace ownership marker；
* marker 必须同时匹配 Testspace kind、当前 repository root 和当前 root；
* 不满足 ownership 时拒绝递归 cleanup。

这意味着 Testspace 不会因为用户误填一个普通目录就对它执行 `rm -rf`。

默认仓库内 `.testspace` 保留旧兼容 ownership 规则；新自定义 root 都必须显式由 Testspace 创建并标记。

## Linux namespace

Linux 上 launcher 会先建立 Testspace 专用 namespace，再在其中执行生命周期命令。`stop`、启动失败或一次性命令完成后会按 launcher 规则销毁 namespace。

非 Linux 平台使用相同的隔离 HOME/runtime 模型，但不依赖 Linux namespace。

Testspace namespace 是为了隔离测试资源和生命周期，不改变 portable-devshell 本身的 RPC/MCP 协议。

## `start` 的修复语义

如果 Testspace 已经运行，再执行：

```bash
pnpm testspace
```

不会盲目创建第二套环境。它会检查并修复：

```text
local instance readiness
Reverse worker connection
activity connector process/health
```

健康组件继续复用；失效组件会重启。如果 connector replacement 过程中失败，脚本会回滚本轮已经替换的 connector，避免留下半修复状态。

## Activity connector

local/reverse endpoint 各有一个活动 connector，用真实 MCP/Control 路径产生可观察活动。它们主要用来让 TUI/Web 在人工验收时持续出现：

```text
ToolCall
Todo
短 shell output
短 tmux task
Comment / Workspace 相关状态
```

connector 有独立 PID、health file、process log 和 event log。`status` 会报告 process 与 health，而不是仅凭 PID 假设 connector 可用。

Testspace 活动应该保持无害、可重复，并局限在 Testspace workspace。

## TUI / Web 人工验收

```bash
pnpm testspace tui
pnpm testspace web
```

这两个入口打开的都是真实产品界面，不是测试专用 mock UI。

人工验收重点：

1. `testspace-local` 与 `testspace-reverse` 都可观察；
2. instance 状态/日志/ToolCall 能持续刷新；
3. TUI 与 Web 对同一 Control 状态一致；
4. MCP tool activity 真实经过 Context/approval/audit；
5. Reverse worker 的断线/恢复不会生成第二套协议状态；
6. tmux task、Todo、Artifact 等长期状态在 UI 中能正常呈现；
7. Workspace/MCP App 需要验证时，应通过真实 endpoint，不用手工伪造 UI snapshot。

## Smoke

```bash
pnpm testspace smoke
pnpm testspace long-smoke
```

`smoke` 是快速自动诊断，不等于最终 acceptance。`long-smoke` 专门验证真实 180 秒 tmux 同步交接边界：请求必须在边界处返回 detached、后台 task 继续存活，并可通过 `tmux_read` 取得最终终态。这个入口显式把 MCP SDK request timeout 设置到同步边界之外，不依赖 SDK 默认值。

根据入口还可以分别运行：

```text
terminal smoke
web smoke
comment smoke
workspace resource + live snapshot smoke
```

项目正式门禁见 [验收与发布门禁](acceptance.md)。

## Stop 与 cleanup

```bash
pnpm testspace stop
```

停止流程会处理 Testspace 自己拥有的：

```text
activity connector
local/reverse worker
Control
tmux runtime
Testspace Docker container
Testspace Podman storage
runtime directories
Testspace root
Linux namespace（适用时）
```

自定义 root 在递归删除前再次验证 ownership marker。

Testspace cleanup 的作用域始终是 Testspace 自己创建/拥有的资源，不能用它来清理普通开发环境。

## 与 acceptance 的区别

```text
Testspace    = 真实产品的隔离观察/交互空间
Acceptance   = 可重复、自动化、用于发布门禁的证明
```

一个 UI 在 Testspace 看起来正常，不代表 release gate 已经通过；反过来，unit test 全绿也不能替代 Testspace 对完整产品交互的人工检查。
