# portable-devshell 文档

这套文档以当前开发源码 `1.0.0-beta.3` 的运行模型为基线，**尚未提升 RC**。Beta 早期缺陷报告、测试矩阵和历史 Release Note 保留原始版本与日期，不能代替当前 HEAD 的验收结论。历史提交中的旧工具名、旧 Workspace 生命周期、旧 MCP session 假设和旧 tmux handoff 时长不作为现行契约。

## 从这里开始

- [安装与升级](getting-started/installation.md)：Release 安装、源码安装、升级、PATH 和卸载。
- [快速开始](getting-started/quickstart.md)：启动 Control、创建 instance、验证 worker 与 MCP。
- [客户端接入](getting-started/clients.md)：Codex、Claude Code、ChatGPT 等 MCP Host 的接入边界。

## 核心概念

- [系统架构](concepts/architecture.md)：Control、Core、Worker、provider 与 HTTP host 的职责边界。
- [MCP](concepts/mcp.md)：endpoint、transport、认证、工具 catalog、兼容策略和长调用 transport。
- [Context](concepts/context.md)：内部 Context、external binding、workspace attachment 与生命周期。
- [Workspace](concepts/workspace.md)：MCP App、Goal、Todo、Wait、Approval 和模型 re-entry。

## 工具

- [文件工具](tools/file.md)：读取视图、搜索、隐式快照和有序 change set 编辑。
- [tmux 工具](tools/tmux.md)：managed task、persistent pane、阻塞等待和 durable handoff。
- [Artifact](tools/artifacts.md)：Artifact 读取、图片、分享与跨实例传输。
- [运行时 Debug Patch](tools/debug.md)：本地 owner-only、Context-scoped、可回滚运行时补丁。
- [Agent Skills](tools/skills.md)：project / managed / global 三层 catalog 与 lazy loading。

## 运维与部署

- [Control 管理面](operations/control-plane.md)：CLI/TUI/Web、overview、watch、audit、Todo 与 instance 管理。
- [配置与运行目录](operations/configuration.md)：Control/instance 配置、路径、CLI 管理面和 worker target。
- [安全、审批与 Secret 扫描](operations/security.md)：ToolCall Review/Rewrite、workspace security、Secret 输入展开/输出 masking 与扫描。
- [OAuth 与公网暴露](operations/oauth.md)：OAuth 资源服务器、审批和代理要求。
- [ChatGPT 公网隧道](operations/chatgpt-tunnels.md)：FRP / Nginx / Cloudflare Tunnel 示例。
- [Reverse Worker](operations/reverse-connections.md)：反向注册、WSS、SSE+POST 回退与重连。
- [Windows](operations/windows.md)：Windows client/worker 能力和平台差异。

## 开发与验收

- [功能与测试矩阵](development/feature-test-matrix.md)：八条主链路、30 组核心能力、12 个 Extension Points、11 个 Extensions 及验收证据。
- [Beta 缺陷与最小复现](development/beta-bug-findings.md)：第三轮负例、独立红测、已修复问题和待 E2E 确认的风险。
- [Testspace](development/testspace.md)：完整本地 DevShell + MCP connector 测试环境。
- [验收与发布门禁](development/acceptance.md)：测试入口、发布前检查与 CI 约束。
- [RC 前收口状态](development/rc-preflight.md)：区分历史提交和当前工作树的功能链证据、交互修复与未解除的发布门禁。
- [Beta.2 Release Note](releases/v1.0.0-beta.2.md)：beta.2 历史变更说明；当前开发版本与 RC 进度以此文档上方的收口状态为准。
- [Version 与 Compatibility Lifecycle](development/compatibility.md)：产品版本、Protocol、Extension API、persistent schema、update 与 migrate 的独立版本和兼容边界。
- [Extension 架构与 ABI 设计](development/extension-design.md)：Capability、Extension Point、generation ownership，以及各 domain 的 public Extension API 边界。
- [Extension Database Capability](development/extension-database.md)：由 Host 持有的 SQLite 连接、事务租约、数据库路径隔离与 Generation 退役。
- [Transport 通信协议](development/transport-protocol.md)：当前 Provider / Carrier → Channel → Frame `envelope` service → Endpoint/Route → Envelope → Rpc/Event/Stream Packet、流控与 Reverse 边界。

## 文档约定

1. **CLI 输出和运行时 schema 是命令参考的最终来源。** 文档解释语义，不复制容易漂移的完整 `--help`。
2. **Context 与 MCP transport session 是不同概念。** 2026-07-28 MCP 不依赖 protocol session；portable-devshell 的 Context 是应用状态。
3. **workspace 不属于 instance 配置。** 它属于一次操作或一个 Context 在某个 instance 上的 environment attachment。
4. **长任务与长 HTTP 请求分离。** `tmux_run(wait=block)` 可以同步等待一段时间，超过产品同步窗口后由 durable Wait/Workspace 接管，但 task 本身继续运行。
5. **旧名称不代表现行协议支持。** MCP endpoint 拒绝 legacy 协议；少量隐藏 stale-recipient 转换不重新进入 catalog。当前 catalog 包含 Worker、Control primitive 与 Extension `mcp.tools`，shell command ACL 是另一条边界。
6. **fresh 默认与旧配置默认分开。** fresh init 使用 OAuth token 审批和 `openai-session`；通用 client 应显式配置 `explicit`。
7. **安全目标与现状分开。** Execute、发布与 Audit 不是统一 Commit；执行后 adapter retry 历史缺陷已有回归，但 Secret 在 inbound Rewrite 后可能进入 Audit 的风险仍需明确处理，见 [安全说明](operations/security.md)和 [RC 前收口状态](development/rc-preflight.md)。
