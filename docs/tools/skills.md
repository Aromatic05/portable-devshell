# Agent Skills

portable-devshell 提供一个分层、按需读取的 Agent Skill catalog。CLI 负责发现本机 Skill；worker handshake 同时暴露目标环境的 managed skills directory，供 Agent 环境 bootstrap 使用。

## 目录优先级

`devshell skill` 按以下顺序查找同名 Skill：

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
```

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

省略 `--workspace` 时，CLI 使用当前工作目录决定 project Skill root：

```text
$PWD/.agents/skills
```

显式传 `--workspace` 可以在不 `cd` 的情况下检查另一个项目：

```bash
devshell skill list --workspace /absolute/project
```

这个 workspace 只影响本机 Skill discovery，不会创建 MCP Context，也不会修改某个 instance 的 environment attachment。

## MCP / Worker 集成

`environ_info` 会从目标 worker 的 handshake/environment 返回 skills directory 信息。Agent 可以据此发现目标环境已安装的 managed Skills。

本机 `devshell skill` catalog 与远程 worker Skill 生命周期不要混为一谈：

* local 环境通常直接读取本机目录；
* SSH/container 等 managed worker 可以在 provider 生命周期中获得受管 Skill；
* self-managed Reverse worker 自己维护远端 `~/.devshell/skill`。

portable-devshell 不把整个 Skill catalog 转成一个巨大的 model-facing MCP tool schema；应该先发现，再按需加载。

## 安全边界

Skill 是**指令与代码资产**，不是天然可信的数据：

* project Skill 由项目仓库控制；
* managed/global Skill 由用户环境控制；
* `skill load/read` 只读取文本，不自动执行相关脚本；
* 是否执行 Skill 中建议的 shell/tool 操作，仍经过普通 tool policy、Approval 与 workspace 安全边界。
