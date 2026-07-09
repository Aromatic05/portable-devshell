# 接入客户端

下面的例子都假设你已经有一个可用的 MCP endpoint：

- 本地调试：`http://127.0.0.1:17890/demo/mcp`
- 公网接入：`https://devshell.example.com/demo/mcp`

如果你要从 ChatGPT 或其他云端客户端接入，请优先使用公网 HTTPS 地址。

## Codex

Codex 支持 streamable HTTP MCP server，可以直接指向 `portable-devshell` 的 instance endpoint。

在 `~/.codex/config.toml` 或项目内 `.codex/config.toml` 添加：

```toml
[mcp_servers.portable_devshell]
url = "http://127.0.0.1:17890/demo/mcp"
```

如果你用的是公网地址，就把 `url` 换成 HTTPS endpoint。

如果 endpoint 开了 OAuth，登录一次：

```bash
codex mcp login portable_devshell
```

补充说明：

- Codex 的 CLI 和 IDE extension 共用同一份 MCP 配置
- 如果你的 OAuth 回调必须固定端口，Codex 官方支持 `mcp_oauth_callback_port` 和 `mcp_oauth_callback_url`

官方文档：

- https://developers.openai.com/codex/mcp

## Claude Code

Claude Code 推荐把远程 MCP server 作为 HTTP transport 添加：

```bash
claude mcp add --transport http portable-devshell http://127.0.0.1:17890/demo/mcp
```

如果要跨项目复用，可以再加 `--scope user`。

如果 endpoint 开了 OAuth，可以用任意一种方式完成登录：

```bash
claude mcp login portable-devshell
```

或者在 Claude Code 里打开：

```text
/mcp
```

然后跟着浏览器授权流程走完。

补充说明：

- Claude Code 的 HTTP transport 支持 OAuth
- 如果服务端要求固定回调端口，Claude Code 官方支持 `--callback-port`

官方文档：

- https://code.claude.com/docs/en/mcp

## ChatGPT Connector

这里沿用“ChatGPT Connector”这个叫法，但 OpenAI 当前文档中的入口已经放在 `Apps & Connectors` 下。

前提：

- 必须是公网 HTTPS endpoint
- 推荐启用 OAuth
- 如果是本地开发，可以先用 Secure MCP Tunnel 或你自己的公网隧道

创建步骤：

1. 在 ChatGPT 打开 `Settings -> Apps & Connectors -> Advanced settings`
2. 启用 developer mode
3. 进入 `Settings -> Connectors -> Create`
4. 填写连接信息

建议这样填写：

- Connector name: `portable-devshell demo`
- Description: 说明这个 instance 对应哪个 workspace、开放了哪些工具
- Connector URL: `https://devshell.example.com/demo/mcp`

如果 endpoint 开了 OAuth，ChatGPT 会根据 `portable-devshell` 暴露的 metadata 自动进入授权流程。

后续刷新工具列表时，在 Connector 详情页点 `Refresh` 即可重新抓取工具元数据。

官方文档：

- https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
