# 接入客户端

下面示例使用名为 `demo-local` 的 instance：

```text
本地 endpoint    http://127.0.0.1:17890/demo-local/mcp
公网 endpoint    https://devshell.example.com/demo-local/mcp
```

本地客户端可以直接使用回环地址；ChatGPT 等云端客户端必须使用公网 HTTPS 地址。

## Codex

Codex 支持 Streamable HTTP MCP。编辑 `~/.codex/config.toml`，或项目目录中的 `.codex/config.toml`：

```toml
[mcp_servers.portable_devshell]
url = "http://127.0.0.1:17890/demo-local/mcp"
```

使用公网 OAuth endpoint 时，把 URL 改为 HTTPS 地址，然后执行：

```bash
codex mcp login portable_devshell
```

检查配置和连接状态：

```bash
codex mcp list
codex mcp get portable_devshell
```

Codex CLI、IDE 扩展与桌面端共用 MCP 配置。OAuth 回调端口有固定要求时，可在 Codex 配置中设置 `mcp_oauth_callback_port` 或 `mcp_oauth_callback_url`。

## Claude Code

使用推荐的 HTTP transport 添加 endpoint：

```bash
claude mcp add --transport http portable-devshell http://127.0.0.1:17890/demo-local/mcp
```

希望跨项目复用时加入用户级 scope：

```bash
claude mcp add --transport http --scope user portable-devshell https://devshell.example.com/demo-local/mcp
```

OAuth endpoint 可以执行：

```bash
claude mcp login portable-devshell
```

也可以在 Claude Code 中输入：

```text
/mcp
```

然后按浏览器授权流程完成登录。需要固定 OAuth 回调端口时，可使用 `--callback-port`。

## ChatGPT 开发者模式应用

ChatGPT 当前把远程 MCP 接入作为开发者模式下的 App/Plugin。旧资料中可能仍称为 ChatGPT Connector，本文中的两种称呼指同一类接入能力。

前提：

- endpoint 必须可从公网访问；
- 必须使用 HTTPS；
- 推荐启用 `portable-devshell` 内置 OAuth；
- instance 已启动，并且 MCP endpoint 能返回 OAuth 元数据。

接入步骤：

1. 在 ChatGPT 的 `Settings → Security and login` 中启用 Developer mode；
2. 打开 `Settings → Plugins`，创建新的开发者应用；
3. 填写名称、说明和公网 MCP URL；
4. 完成 OAuth 注册和授权；
5. 回到 `portable-devshell` TUI 的 `OAuth` 页面批准待处理请求；
6. 在 ChatGPT 中刷新应用工具列表。

推荐填写：

```text
名称        portable-devshell demo-local
说明        demo-local 工作区的开发环境工具
MCP URL     https://devshell.example.com/demo-local/mcp
```

不要填写 control 的根地址，也不要省略 instance path。

## 工具没有出现

依次检查：

```bash
devshell status
devshell instance status demo-local
devshell instance logs demo-local
```

然后确认：

1. 全局 `mcp.enabled = true`；
2. 实例 `[mcp].enabled = true`；
3. `[mcp.tools].groups` 包含目标工具所属 group；
4. `[mcp.tools].capabilities` 包含工具要求的 capability；
5. 客户端已刷新 MCP 工具列表；
6. OAuth 注册和授权请求已经在 TUI 中批准。

工具策略见 [mcp.md](mcp.md)，公网配置见 [oauth.md](oauth.md)。
