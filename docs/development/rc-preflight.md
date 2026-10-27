# RC 发布前收口与验证记录

> 更新于 2026-10-27。历史提交的测试结果不能替代当前发布提交的 CI。

## RC 决议与待执行步骤

维护者已批准从 `1.0.0-beta.3` 提升到 `1.0.0-rc.1`。当前最后一个完整功能修复基线为 `6d46905b`，本轮代码修复、构建和验收已通过：

- 本地开发标签门禁 `node scripts/run-dev-tag-gate.mjs` 完整通过，覆盖脚本、Lint、类型检查、生产构建、Rust Worker/Tmux、全部 Package Tests、真实 Reverse Worker、安装和升级模拟、MCP、长时 Tmux handoff 及 Chromium 浏览器。保留日志于 Git 忽略的 `var/agent-work/rc-build-ci-20261027/`。
- 正式 `dev1.0.0-beta.3-1` 标签的 push CI [40518417367](https://github.com/Aromatic05/portable-devshell/actions/runs/40518417367)：**8/8 成功**；同提交手动主 CI [40516095452](https://github.com/Aromatic05/portable-devshell/actions/runs/40516095452)：**8/8 成功**。包括真实 Darwin x64/arm64、macOS 专项合约、Windows x64/arm64、Linux x64/arm64 与 Linux 通用正确性。
- 同提交扩展 CI `beta-matrix-extended`：Extension 生命周期 [40516232704](https://github.com/Aromatic05/portable-devshell/actions/runs/40516232704)、四条完整功能链 [40516242752](https://github.com/Aromatic05/portable-devshell/actions/runs/40516242752)、真实升级/迁移/回滚 [40516250485](https://github.com/Aromatic05/portable-devshell/actions/runs/40516250485)、Windows psmux [40516258860](https://github.com/Aromatic05/portable-devshell/actions/runs/40516258860)，**4/4 成功**。
- 两台现有仓库 HEAD 与 `origin/main` 一致，工作树干净；测试用代码未运行成用户当前安装的软件版本。

此处验收针对 `6d46905b`。**提升 RC 版本将产生新的 Git 提交**；RC 标签不能直接复用上述 dev-tag 证明。必须在 RC 版本提交上重新执行本地 dev-tag gate、同提交的 `dev*` push CI，再创建 `v1.0.0-rc.1` 标签，由 [release 工作流](../../.github/workflows/release.yml) 验证、构建六目标和发布。发布后默认分支将由工作流自动提升到下一开发版本。

## 本地信任边界

本地环境由维护者定义为可信。Secret 在本地运行时展开、在本地 Audit SQLite 保存展开值，**不构成 RC 安全阻断项**；不能因本地明文存储而擅自要求隔离或加密。只有数据发生实际的未经授权的跨信任边界传输，才构成另行审查的事项。该决议不改变现有外部 MCP/OAuth/Context 鉴权策略。

## 已完成的主要收口

- MCP App 构建依赖、Comment 外层结果交付和工作台审批浏览器合约。
- Transport 的 Channel/Session 归属；Reverse Worker 明确替换与重注册；Tmux 列表/任务作用域、终端持久化。
- Worker 输出流控与安装时拒绝工具内自升级；CLI/TUI 输入与恢复；Web Audit 性能和状态反馈。
- `var/` 在仓库级 Git 忽略；代理并发修改仅在既有工作树中进行，最终历史为线性提交。

## 历史验收记录（不作为当前版本发布证明）

2026-10-26，`c4ab5cc8` 及后续尚未提交工作树的 `acceptance/run-chain-matrix.mjs --all` 都曾完成四链（L07、L05、L03、L01–L04），包括跨越 180 秒的 Wait handoff。日志保留在 `var/agent-work/rc-preflight-20261026/`。

2026-10-25，`e2482d25` 的 GitHub 主 CI [40196641772](https://github.com/Aromatic05/portable-devshell/actions/runs/40196641772) 曾在 macOS 上出现 Worker process group `EPERM` 故障。此项由后续修复和上述 `6d46905b` 的原生 macOS Runner 门禁重新验证，**旧失败不是当前阻断项**。

仍需区分源码层/CI 验证与用户侧的真实 Docker/Podman 引擎、外部 ChatGPT 公网 OAuth 部署等现场限制，未覆盖的运行环境不能声称已实测。发布执行入口参阅 [验收门禁](acceptance.md)。
