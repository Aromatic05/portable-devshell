# Agent Skills

portable-devshell 的 Skill 功能由 builtin **Skill Extension** 提供。Extension 运行在 Control：负责本机 Skill discovery、catalog、内容快照与显式传输；Worker 不实现 Skill 协议，也不会在 provider 生命周期里自动同步 Skill。

Skill 到达目标 Worker 后只是普通文件。Agent 后续读取 `SKILL.md`、读取附属文件和执行脚本仍使用 `file_read` / `file_search` / `bash` / `tmux` 等普通 Worker tools。

## 目录优先级

`devshell skill` 在 Control 主机按以下顺序查找同名 Skill：

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

`SKILL.md` 是入口。相关文件可以是脚本、README、配置模板等，但读取仍限制在该 Skill root 内；canonical path 逃逸会被拒绝。

## CLI

```bash
devshell skill list [--workspace <directory>]
devshell skill search <query> [--workspace <directory>]
devshell skill load <name> [--workspace <directory>]
devshell skill inspect <name> [--workspace <directory>]
devshell skill read <name> <path> [--workspace <directory>]
devshell skill get <name> <instance> [--workspace <local-directory>]
```

这些命令读取 Control 主机文件，因此只接受 local-owner CLI 调用。CLI 会把调用者真实工作目录作为 Extension invocation context 传给 Control；Skill Extension 不使用 Control daemon 自己的 `process.cwd()`。

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

Worker Resource Host 只负责受控的 instance-scoped resource namespace；Artifact receive 继续负责 payload 校验、staging 与目标替换。Skill Extension 不打开 Worker tool session，也不调用 `bash_run`。SSH/Docker/Podman/Reverse 不参与 Skill 语义，也没有另一套 tar/mv shell installer。

`get` 是显式操作，不会因为 instance start、RPC reconnect 或 provider install 自动复制整套 catalog。重复 `get` 同名 Skill 会用新快照替换该目标 Skill；其他目标 Skill 不受影响。

## Lazy loading

Skill catalog 的设计目标是避免把所有说明一次性塞进 Agent context：

```text
list/search  -> metadata only
load         -> one SKILL.md
read         -> one related file
```

当前边界包括：

```text
最多 catalog Skill       256
单个完整 Skill 文件      512 KiB
list description preview  64 KiB
related files             1000
related scan entries      5000
```

这些限制是 catalog 资源边界，不代表 Agent 应该把达到上限的内容全部送进模型。

## Workspace 参数

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

MCP builtin module 的 `environ_info` 仍返回 `skillsDirectory` 作为产品级环境信息。MCP 通过通用 Worker Resource Host 准备 `extensionId=skill, collection=managed`，并返回 Worker 给出的真实 collection directory。该路径属于当前 instance，而不是从 `homeDirectory` 拼出来的用户级目录。

```text
<instance resource root>/extensions/skill/resources/managed
```

因此 Agent 可以先通过 `environ_info` 得到目标 managed Skill 位置，再使用普通 `file_read` / `file_search` 按需读取已经 `get` 到该 Worker 的 Skill。

portable-devshell 不把整个 Skill catalog 转成巨大的 model-facing MCP schema；应该先发现/传输，再在目标环境按需读取。

## 安全边界

Skill 是**指令与代码资产**，不是天然可信的数据：

* project Skill 由项目仓库控制；
* managed/global Skill 由 Control 主机用户环境控制；
* `skill load/read` 只读取文本，不自动执行相关脚本；
* `skill get` 只传输选中的资产，不执行 Skill 内容；
* Resource Host 只接受合法 Extension/collection namespace，并拒绝符号链接劫持的资源目录；
* Artifact transfer 只能传输 Extension 已安装的 asset generation，不能借此读取任意 Control host path；
* 后续执行 Skill 中建议的 shell/tool 操作仍经过普通 tool policy、Approval、Audit 与 workspace 安全边界。
