# 文档索引

## 上手

- [installation.md](installation.md)：发布包安装、源码安装、升级、PATH 和卸载。
- [quickstart.md](quickstart.md)：创建第一个 instance，启动 worker，并验证工具调用。
- [clients.md](clients.md)：接入 Codex、Claude Code 和 ChatGPT Connector。

## 运行与配置

- [architecture.md](architecture.md)：当前 control、core、worker、MCP 和 provider 架构。
- [reference.md](reference.md)：配置文件、运行目录、worker target 和环境变量。
- [mcp.md](mcp.md)：MCP endpoint、工具 group/capability 和手动验证。
- [oauth.md](oauth.md)：公网暴露、OAuth 配置和审批流程。
- [chatgpt-connector-tunnels.md](chatgpt-connector-tunnels.md)：使用 FRP 或 Cloudflare Tunnel 暴露 HTTPS endpoint。

## 工具与协议

- [tmux.md](tmux.md)：长任务、交互式进程和多 pane 工作流。
- [artifacts.md](artifacts.md)：Artifact 读取、分享和跨实例传输。
- [todo.md](todo.md)：Agent Todo 状态、revision 和事件。
- [reverse-connections.md](reverse-connections.md)：反向 worker 的注册、WSS 与 SSE 回退协议。

## 历史资料

- [portable-devshell-ts-design.md](portable-devshell-ts-design.md)：设计文档入口。
- [archive/portable-devshell-ts-design-0.1.md](archive/portable-devshell-ts-design-0.1.md)：2026-07-07 的 0.1 冻结设计归档，不代表当前实现。
