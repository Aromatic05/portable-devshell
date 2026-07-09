# 快速开始

这份文档面向“直接从当前源码仓库跑起来”的场景。

## 前提

- 已安装 `pnpm`
- 已安装 Rust toolchain
- 当前 shell 里有 `XDG_RUNTIME_DIR`

如果 `XDG_RUNTIME_DIR` 为空，control daemon 无法创建运行时 socket。

## 1. 构建 CLI 和 worker

```bash
pnpm install
pnpm build
cargo build -p devshell-worker --manifest-path ./Cargo.toml
```

CLI 入口是：

```text
node packages/cli/dist/cli/CliMain.js
```

下面示例都直接用这个入口。

## 2. 启动 control daemon

```bash
node packages/cli/dist/cli/CliMain.js start
```

第一次启动时，如果 `~/.devshell/control/config.toml` 不存在，会自动写入默认配置。

可以马上确认 control 是否正常：

```bash
node packages/cli/dist/cli/CliMain.js status
```

## 3. 创建第一个 instance

运行交互式向导：

```bash
node packages/cli/dist/cli/CliMain.js instance create
```

建议第一次先用下面这组值：

- `provider`: `local`
- `workspace`: 你的项目目录
- `MCP enabled`: `yes`
- `allowed tools`: 先保留默认值，或最小化为 `bash_run`

向导会把实例配置写到：

```text
~/.devshell/control/instances/<name>.toml
```

## 4. 启动 instance

```bash
node packages/cli/dist/cli/CliMain.js instance start <name>
```

查看状态：

```bash
node packages/cli/dist/cli/CliMain.js instance status <name>
```

如果输出里出现 `status: ready` 或 `ready: true`，说明 worker 和控制链路已经起来了。

## 5. 做一次最小调用

```bash
node packages/cli/dist/cli/CliMain.js instance call <name> bash_run '{"command":"pwd"}'
```

再看一次实例日志：

```bash
node packages/cli/dist/cli/CliMain.js instance logs <name>
```

## 6. 停止服务

停止某个 instance：

```bash
node packages/cli/dist/cli/CliMain.js instance stop <name>
```

停止 control daemon：

```bash
node packages/cli/dist/cli/CliMain.js stop
```

## 下一步

- 想把 instance 暴露成 MCP：见 [mcp.md](mcp.md)
- 想打开公网并接 OAuth：见 [oauth.md](oauth.md)
- 想接入 Codex、Claude Code、ChatGPT：见 [clients.md](clients.md)
- 想手写配置文件或查路径：见 [reference.md](reference.md)
