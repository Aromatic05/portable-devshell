# Agent Skills

portable-devshell 的 Skill 功能由 builtin **Skill Extension** 提供。Extension 运行在 Control：负责 native 本机 discovery、model Worker workspace discovery、catalog、内容快照与显式传输；Worker 不实现 Skill 协议，也不会在 provider 生命周期里自动同步 Skill。

Skill 到达目标 Worker 后只是普通文件。Agent 可通过 model `skill load/read` 读取内容；直接读取文件和执行脚本仍使用 `file_read` / `file_grep` / `bash` / `tmux` 等普通 Worker tools。

## 目录优先级

native `devshell skill` 在 Control 主机按以下顺序查找同名 Skill：

```text
1. project  <workspace>/.agents/skills/<name>/
2. managed  ~/.devshell/skill/<name>/
3. global   $XDG_CONFIG_HOME/agents/skills/<name>/
```

没有 `XDG_CONFIG_HOME` 时 global 根使用：

```text
~/.config/agents/skills
```

同名 Skill 只采用最高优先级来源，低优先级副本会以 warning 报告，而不是合并两个目录。

## Skill 结构

一个 Skill 至少是目录中的：

```text
<name>/
  SKILL.md
  ... optional related files
```

`SKILL.md` 是入口。相关文件可以是脚本、README、配置模板等。Native/Control catalog 读取会检查 canonical path，拒绝逃逸 Skill root。Model Worker project 读取校验 Skill name 和相对文件路径（拒绝绝对路径及 `..`），实际文件访问经过 Worker tools 的 workspace/security policy；不能把 Control catalog 的 canonical-root 检查直接当成 Worker project 的实现保证。

## Native CLI

```bash
devshell skill list [--workspace <directory>]
devshell skill search <query> [--workspace <directory>]
devshell skill load <name> [--workspace <directory>]
devshell skill inspect <name> [--workspace <directory>]
devshell skill read <name> <path> [--workspace <directory>]
devshell skill get <name> <instance> [--workspace <local-directory>]
```

以上 native 命令读取 Control 主机文件，因此只接受 local-owner CLI 调用。CLI 会把调用者真实工作目录作为 Extension invocation context 传给 Control；Skill Extension 不使用 Control daemon 自己的 `process.cwd()`。

`inspect` 当前与 `load` 使用同一完整加载语义。

### `list`

只返回轻量 metadata：

```text
name
description
source
```

为了得到 description，会读取 `SKILL.md` 的有限 preview，而不会遍历/返回所有 Skill 内容。

### `search`

在 `name + description` 上做不区分大小写的 substring 过滤。它先执行同样的分层 discovery，因此同名优先级规则保持一致。

### `load` / `inspect`

读取完整 `SKILL.md`，并列出 related files：

```text
bytes
content
description
name
relatedFiles
source
sourcePath
```

### `read`

按需读取一个 related file：

```bash
devshell skill read my-skill scripts/check.sh --workspace /project
```

`SKILL.md` 本身必须使用 `load`，不能通过 `read` 绕过入口语义。

### `get`

`get` 把当前 discovery 选中的**一个** Skill 投影到指定 Worker 的 instance-scoped managed resource collection：

```bash
devshell skill get my-skill remote-dev --workspace /local/project
```

流程是：

```text
Control Skill source
    -> Extension asset snapshot (content-addressed)
    -> Worker Resource Host prepares skill/managed collection
    -> Artifact transfer
    -> <managed collection>/<name>/ on the Worker
```

Worker Resource Host 只负责受控的 instance-scoped resource namespace；Artifact receive 继续负责 payload 校验、staging 与目标替换。这条 native `get` 投影链路不打开 Worker tool session，也不调用 `bash_run`。SSH/Docker/Podman/Reverse 不参与 Skill 语义，也没有另一套 tar/mv shell installer。

`get` 是显式操作，不会因为 instance start、RPC reconnect 或 provider install 自动复制整套 catalog。重复 `get` 同名 Skill 会用新快照替换该目标 Skill；其他目标 Skill 不受影响。

## Model command

模型通过 MCP `bash_run` / managed `tmux_run` 中的 Context-bound `devshell` shim 使用独立的 `cli.model-commands/skill`：

```bash
devshell skill list
devshell skill search <query>
devshell skill load <name>
devshell skill inspect <name>
devshell skill read <name> <path>
```

这个入口不支持 `get`、`--workspace` 或任意目标 instance。Broker 从当前 Context 注入 `instance` 与 `workspace`；Skill Extension 以此打开 `worker.execute` session，通过 Worker `file_glob/file_read` 读取当前 workspace 的 `.agents/skills`，并在命令结束时关闭 session。它不使用 Control-host cwd 发现 project Skill。

Model discovery 将 Worker project Skill 与 Control managed/global catalog 合并，project 同名优先，其次 managed、global。`load/inspect/read` 优先读取 Worker project 内容；不存在该 project Skill 时才选择 Control catalog。模型结果去掉 Control `sourcePath`。这里的 session 与 native `get` 的 Resource Host 投影是不同链路；不需要先 `get` 才能调用 model `load`。

## Lazy loading

Skill catalog 的设计目标是避免把所有说明一次性塞进 Agent context：

```text
list/search  -> metadata only
load         -> one SKILL.md
read         -> one related file
```

Control-host catalog 当前边界包括（Worker project 读取还受 Worker tools 自身限制，不应将这些数字当成两条实现完全相同的保证）：

```text
最多 catalog Skill       256
单个完整 Skill 文件      512 KiB
list description preview  64 KiB
related files             1000
related scan entries      5000
```

这些限制是 catalog 资源边界，不代表 Agent 应该把达到上限的内容全部送进模型。

## Native workspace 参数

省略 `--workspace` 时，local-owner CLI 的当前工作目录决定 project Skill root：

```text
$PWD/.agents/skills
```

显式传 `--workspace` 可以在不 `cd` 的情况下检查另一个本地项目：

```bash
devshell skill list --workspace /absolute/project
```

这个 workspace 只影响 **Control 主机上的 Skill discovery**，不会创建 MCP Context，也不会修改 instance attachment。

`skill get` 的 `<instance>` 只选择目标 Worker。managed Skill 是 instance-scoped resource，不需要再提供一个与投影无关的目标 workspace。

## MCP / Worker 集成

Worker handshake 只暴露通用环境，例如 `homeDirectory` 和 platform；它不包含 Skill-specific 字段。

`environ_info` 在环境准备时仍通过通用 Worker Resource Host 创建 `extensionId=skill, collection=managed`，但当前返回值**没有 `skillsDirectory`**，不能用它取得 Skill 路径。Resource Host 的物理布局是：

```text
<instance resource root>/extensions/skill/resources/managed
```

这是 native `get` 目标的实现布局，不是环境工具的输出字段。模型发现、加载与读取 Skill 应使用上述 Context-bound model commands；读取已知 Worker 文件也可使用普通文件工具。

portable-devshell 不把整个 Skill catalog 转成巨大的 model-facing MCP schema；模型先 `list/search`，再 `load/read` 所需内容；native 传输另用显式 `get`。

## 安全边界

Skill 是**指令与代码资产**，不是天然可信的数据：

- project Skill 由项目仓库控制；
- managed/global Skill 由 Control 主机用户环境控制；
- `skill load/read` 只读取文本，不自动执行相关脚本；
- `skill get` 只传输选中的资产，不执行 Skill 内容；
- Resource Host 只接受合法 Extension/collection namespace，并拒绝符号链接劫持的资源目录；
- Artifact transfer 只能传输 Extension 已安装的 asset generation，不能借此读取任意 Control host path；
- 后续执行 Skill 中建议的 shell/tool 操作仍经过普通 tool policy、Approval、Audit 与 workspace 安全边界。
