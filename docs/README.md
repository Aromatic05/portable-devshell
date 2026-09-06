# portable-devshell 文档

这套文档描述当前 `0.6.x` 代码与运行模型。历史提交中的旧工具名、旧 Workspace 生命周期、旧 MCP session 假设和旧 tmux handoff 时长不作为现行契约。

## 从这里开始

* [安装与升级](getting-started/installation.md)：Release 安装、源码安装、升级、PATH 和卸载。
* [快速开始](getting-started/quickstart.md)：启动 Control、创建 instance、验证 worker 与 MCP。
* [客户端接入](getting-started/clients.md)：Codex、Claude Code、ChatGPT 等 MCP Host 的接入边界。

## 核心概念

* [系统架构](concepts/architecture.md)：Control、Core、Worker、provider 与 HTTP host 的职责边界。
* [MCP](concepts/mcp.md)：endpoint、transport、认证、工具 catalog、兼容策略和长调用 transport。
* [Context](concepts/context.md)：内部 Context、external binding、workspace attachment 与生命周期。
* [Workspace](concepts/workspace.md)：MCP App、Goal、Todo、Wait、Approval 和模型 re-entry。

## 工具

* [文件工具](tools/file.md)：读取视图、搜索、隐式快照和有序 change set 编辑。
* [tmux 工具](tools/tmux.md)：managed task、persistent pane、阻塞等待和 durable handoff。
* [Artifact](tools/artifacts.md)：Artifact 读取、图片、分享与跨实例传输。
* [运行时 Debug Patch](tools/debug.md)：本地 owner-only、Context-scoped、可回滚运行时补丁。
* [Agent Skills](tools/skills.md)：project / managed / global 三层 catalog 与 lazy loading。

## 运维与部署

* [Control 管理面](operations/control-plane.md)：CLI/TUI/Web、overview、watch、audit、Todo 与 instance 管理。
* [配置与运行目录](operations/configuration.md)：Control/instance 配置、路径、CLI 管理面和 worker target。
* [安全、审批与 Secret 扫描](operations/security.md)：tool approval、workspace security 和本机 secret preflight。
* [OAuth 与公网暴露](operations/oauth.md)：OAuth 资源服务器、审批和代理要求。
* [ChatGPT 公网隧道](operations/chatgpt-tunnels.md)：FRP / Nginx / Cloudflare Tunnel 示例。
* [Reverse Worker](operations/reverse-connections.md)：反向注册、WSS、SSE+POST 回退与重连。
* [Windows](operations/windows.md)：Windows client/worker 能力和平台差异。

## 开发与验收

* [Testspace](development/testspace.md)：完整本地 DevShell + MCP connector 测试环境。
* [验收与发布门禁](development/acceptance.md)：测试入口、发布前检查与 CI 约束。

## 文档约定

1. **CLI 输出和运行时 schema 是命令参考的最终来源。** 文档解释语义，不复制容易漂移的完整 `--help`。
2. **Context 与 MCP transport session 是不同概念。** 2026-07-28 MCP 不依赖 protocol session；portable-devshell 的 Context 是应用状态。
3. **workspace 不属于 instance 配置。** 它属于一次操作或一个 Context 在某个 instance 上的 environment attachment。
4. **长任务与长 HTTP 请求分离。** `tmux_run(wait=block)` 可以同步等待一段时间，超过产品同步窗口后由 durable Wait/Workspace 接管，但 task 本身继续运行。
5. **旧 wire 名称只用于兼容。** 已从 model-facing catalog 移除的工具或 app-only helper 不应出现在新文档示例中。
