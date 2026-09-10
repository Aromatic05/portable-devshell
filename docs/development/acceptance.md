# 验收与发布门禁

这份文档只记录**当前可执行的门禁**。不保存“某个历史版本已经通过”的静态结论；Release 是否可交付，应由同一提交上的本地验收与 CI/Release workflow 共同证明。

## 完整本地验收

```bash
bash acceptance/run-final-acceptance.sh
```

当前脚本执行：

```text
pnpm build
pnpm typecheck
cargo build --locked --workspace
pnpm test
cargo test --locked --workspace
pnpm test:worker:tmux           # 非 Windows
real Worker smoke
MCP smoke
Web browser smoke
```

其中 integration smoke 复用同一 prepared worker，不应该以 mock transport 代替最终 Worker 行为。

## 分项入口

```bash
bash acceptance/run-typecheck.sh
bash acceptance/run-unit-tests.sh
bash acceptance/run-real-worker-smoke.sh
bash acceptance/run-mcp-smoke.sh
```

需要只运行最终 integration 链时，可以直接调用 `run-final-acceptance.mjs --integration-only`。

## Development CI

`.github/workflows/ci.yml` 当前只由：

```text
workflow_dispatch
pull_request
dev* tag push
```

触发。普通 branch/main push 不单独触发该 workflow。

CI 分为三类证明：

### common-linux-x64

运行通用正确性门禁，包括 Web browser 所需 Chromium 环境。

### macos-contract-arm64

验证 macOS 平台行为契约，而不是重复执行全部平台无关测试。

### verify-target

六目标矩阵：

```text
linux-x64
linux-arm64
darwin-x64
darwin-arm64
windows-x64
windows-arm64
```

每个目标执行对应 release-asset gate，并上传该提交的候选资产。Linux x64 额外保留完整 acceptance 日志。

Windows runner 当前只证明 JS 应用、原生 Worker 和最终应用包的构建/打包目标；通用 TypeScript/Rust 正确性由 common job 证明。不要把“Windows target 构建成功”描述成已经覆盖了与 Unix 同等的 PowerShell/ConPTY runtime 交互测试。

## Release workflow

正式 `v*` tag 触发 `.github/workflows/release.yml`。

发布前 workflow 先验证：

1. release commit 是默认分支祖先；
2. tag 与项目版本一致；
3. tag 尚未发布；
4. **同一 commit 的 development CI 已成功**。

之后六个原生目标分别构建 Worker 与应用包。非 Windows target 还执行最终 Worker daemon、Reverse Worker PTY、Client/local instance、应用包和 Unix installer smoke。

只有全部目标成功后才发布 GitHub Release。发布完成后 workflow 会在默认分支推进到下一个开发版本。

## 最终 0.6.x 配置契约

发布前文档与测试应统一确认：

```text
global config write version    2
instance config write version  4
```

旧 global version 1 与 instance version 2/3 只作为 migration input；新示例不能继续写旧结构。

instance version 4 中：

* 不存在持久化默认 workspace path；`[workspace].enabled` 只是 Workspace App/Goal/Wait recovery 子系统开关；
* 不存在 MCP group/capability policy；`tools/list` 使用固定 runtime catalog；
* `[extensions].model` 是 model Extension command allowlist；当前 bundled 默认是 `artifact / instance / mcp / secret / skill`，独立安装的 `agent` 需要显式加入；
* MCP 不暴露 `instance_connect`；模型通过 Instance Extension 的 `devshell instance connect <instance> [workspace]` 修改当前 Context attachment；
* `devshell instance ...` 仍保留 builtin CLI 管理主干；Artifact 管理/传输由真实 builtin Artifact Extension 的 `cli.native-commands` / `cli.model-commands` registrations 提供，而不是 Control-resident provider、builtin Artifact parser 或 `artifact_transfer` MCP tool。

## MCP / Context / Workspace 门禁

0.6.x 最终版至少应证明：

1. `explicit` Context 可以通过 `environ_info` bootstrap 并继续普通工具调用；
2. `openai-session` 不把内部 `ctxId` 暴露到 model-facing schema；
3. App-only Workspace 调用仍能用内部 `ctxId` + capability 定位同一个 Context；
4. `environ_info` 正常 bootstrap Workspace，`workspace_open` 只承担 re-presentation/restoration；
5. Goal/Todo/Question/Approval/Wait 的 ownership 与 revision fencing 不因 remount/restart 丢失；
6. `Stop waiting` 不停止 tmux task；
7. MCP v2 request-scoped SSE keepalive 能让长 `tools/call` 跨过普通 HTTP idle timeout；
8. `tmux_run(wait=block)` 在 180 秒内可以真实同步返回，超过 180 秒正常 `detached`，task 继续运行；
9. Control/MCP restart 后 durable Wait 可以恢复，而不会重复执行原 tmux task。

## OAuth / 公网门禁

公网安全不是由 `listenHost` 自动推断的策略。

允许的配置包括 `auth = "none"`、`token`、`oauth2`；选择无认证公网部署时，风险由部署者承担，Control 不偷偷改写或拒绝配置。

正式公网 ChatGPT/云 Host 验收应优先覆盖 OAuth：

* protected-resource metadata；
* authorization-server discovery；
* resource/audience/scope；
* PKCE；
* refresh/revocation；
* v2 OAuth issuer validation；
* 代理不缓存/缓冲 request-scoped SSE。

## 安装/升级门禁

至少确认：

1. Release 安装器只预装当前 Control 主机 target 的 Worker；
2. 其他 target 由 provider 首次连接时按需下载并校验；
3. `pnpm install:local` 在候选 build/CLI 验证通过后才切换版本；
4. 安装前运行中的 Control/managed instance 可以在成功切换后恢复；
5. 安装失败可以回滚旧版本并尽量恢复原运行态；
6. Reverse instance 保持 self-managed，不被本机安装器错误启动；
7. Linux/macOS 在没有显式 `XDG_RUNTIME_DIR` 时仍能解析同一用户 Control socket；
8. 六个原生 target 都有对应应用包和 Worker asset；
9. Unix 与 Windows 安装脚本及校验文件全部随 Release 发布。

## 文档门禁

发布前还应检查：

* README 与 `docs/README.md` 不包含不存在的相对链接；
* 不再出现 OpenAI 90 秒 tmux handoff 的旧说明；
* 不把 `Mcp-Session-Id` 写成 Context identity；
* 不把 instance version 2 当成当前配置；
* 不把 `workspace` 写回 instance config；
* 不把 app-only Workspace helper 推荐给模型；
* 当前 CLI 示例能在 `devshell --help` / 子命令 help 中找到对应入口。
