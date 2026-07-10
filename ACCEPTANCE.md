# Current Acceptance

## Commands

- `bash acceptance/run-final-acceptance.sh`
- `bash acceptance/run-typecheck.sh`
- `bash acceptance/run-unit-tests.sh`
- `bash acceptance/run-real-worker-smoke.sh`
- `bash acceptance/run-mcp-smoke.sh`

`acceptance/run-final-acceptance.sh` 串行执行：

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `cargo test --manifest-path ./Cargo.toml`
- `cargo build --manifest-path ./Cargo.toml`
- `bash acceptance/run-real-worker-smoke.sh`
- `bash acceptance/run-mcp-smoke.sh`

## Acceptance Checks

### 1. README 与代码路径一致

- status: pass
- evidence: `README.md` 现在明确 `~/.devshell/control/config.toml`、`~/.devshell/control/instances/*.toml`、`$XDG_RUNTIME_DIR/portable-devshell/control.sock`；`packages/control/src/control/path/ControlPathRuntime.ts` 和 `packages/control/test/unit/ControlConfig.test.ts` test `ControlPathRuntime` 使用同一路径。
- fix commit: this batch

### 2. README 不再描述旧架构或夸大 TUI 完成度

- status: pass
- evidence: `README.md` 明确 CLI/TUI 是 control client，不直接读文件、不 spawn worker、不直连 worker RPC；当前 TUI 由 `TuiRuntime`、`TuiControlSession`、`TuiAppStore` 和 interaction 层组成，不宣称超出已实现页面与交互范围的能力。
- fix commit: this batch

### 3. MCP 是 per-instance endpoint，且不暴露管理面

- status: pass
- evidence: `README.md` 明确 MCP 只暴露 per-instance endpoint；`packages/mcp/src/mcp/host/route/McpHostRouteMatcher.ts` 只匹配 `/<instance>/mcp`；`packages/mcp/test/integration/McpHttpServer.test.ts` test `missing instance returns 404`。
- fix commit: this batch

### 4. approval gate 与 TUI approval inbox 的职责边界正确

- status: pass
- evidence: `README.md` 明确 approval gate 在 core `WorkerInstance.callTool`，TUI approval inbox 只负责展示和决策输入；`packages/core/test/integration/WorkerInstanceReal.test.ts` tests `WorkerInstance waits for approval before invoking tools and persists approval records` 与 `WorkerInstance denies and expires approval-gated calls without invoking tools`；`packages/mcp/test/integration/McpRealWorker.test.ts` test `MCP tools/call waits for approval before invoking the worker tool`。
- fix commit: this batch

### 5. control 不提供 global timeline / logs / tool calls

- status: pass
- evidence: `README.md` 明确 control 不做 global 聚合；`packages/control/src/route/RouteMethodRegistry.ts` 只注册 `instance.readLogs`、`instance.readToolCalls` 等 per-instance route；`packages/control/test/unit/RouteRouter.test.ts` test `RouteMethodRegistry resolves control and instance methods`。
- fix commit: this batch

### 6. stream gap 初始与运行期恢复可观察

- status: pass
- evidence: `packages/control/test/unit/StreamSubscription.test.ts` tests `StreamSubscriptionManager returns stream.gap when fromSeq is unavailable` 和 `StreamSubscriptionManager emits runtime stream.gap before cancelling the subscription`；`packages/control/test/integration/StreamRecovery.test.ts` 验证客户端收到 `stream.gap`、`stream.cancelled` 后可 resubscribe；`packages/core/test/unit/LogStore.test.ts` test `InstanceEventBuffer replays from fromSeq and reports stream.gap`。
- fix commit: none

### 7. instance status / connection / ready 与 worker rpc 事件可驱动 view model

- status: pass
- evidence: `packages/core/test/integration/WorkerInstanceReal.test.ts` tests `WorkerInstance completes lifecycle against frozen devshell-worker`、`WorkerInstance refreshStatus updates snapshot from worker status without auto start`、`WorkerInstance reconnectRpc refreshes schema after an rpc disconnect`，覆盖 `instance.statusChanged`、`instance.connectionChanged`、`instance.readyChanged`、`worker.rpcConnected`、`worker.rpcDisconnected`、`worker.schemaRefreshed`、`log.appended`、`toolCall.*`。
- fix commit: none

### 8. instance.readToolCalls route、历史恢复与 source 识别成立

- status: pass
- evidence: `packages/control/test/integration/ControlRpcServer.test.ts` 验证 `instance.readToolCalls` route、`control.identifyClient`、CLI/TUI source 推导与 unknown client 拒绝；`packages/cli/test/integration/CliControl.test.ts` test `CliControlClient performs control rpc over unix socket` 覆盖 CLI 通过 control 读取 tool calls；`packages/tui/test/integration/TuiControlSession.test.ts` 通过 `readToolCalls()` 恢复历史 audit timeline；`packages/mcp/test/integration/McpRealWorker.test.ts` 记录 `source === "mcp"`。
- fix commit: none

### 9. approval allow / ask / deny / timeout 与 MCP approval gate 经过真实链路验证

- status: pass
- evidence: `packages/core/test/integration/WorkerInstanceReal.test.ts` 覆盖 `ask -> approve`、`deny`、`timeout/expired`；`packages/mcp/test/integration/McpRealWorker.test.ts` 覆盖 MCP 调用进入 pending approval、批准后执行、拒绝后返回 structured error。
- fix commit: none

### 10. config validate / update / apply 与 security.mode runtime env 成立

- status: pass
- evidence: `packages/control/test/unit/ControlConfigEditorService.test.ts` tests `config editor accumulates apply summary across multiple updates`、`config editor allows updating and disabling a running instance without dropping current control`、`config editor refuses deleting a running instance`；`packages/control/test/unit/InstanceConfigMapper.test.ts` test `instance config mapper passes effective security mode, worker env, and approval policy into runtime config`。
- fix commit: none

### 11. TuiControlSession gap / reconnect 与 view model 恢复成立

- status: pass
- evidence: `packages/tui/test/integration/TuiControlSession.test.ts` 覆盖 control 连接、实例快照、stream gap 恢复与 control 缺失；`packages/tui/test/unit/TuiInteractionInfrastructure.test.ts` 覆盖 store 驱动的页面、实例、日志、audit、approval 与 connector 视图模型。
- fix commit: none

### 12. TUI interaction 的 focus / keymap / form / modal / save-cancel / Enter / Esc / Tab 语义成立

- status: pass
- evidence: `packages/tui/src/interaction/TuiFocusManager.ts`、`KeyDispatcher.ts` 与 `CommandDispatcher.ts` 共同实现连续 sidebar 焦点、Tab 区域切换、box/form/wizard/action menu 交互及 Enter/Esc 语义；`packages/tui/test/unit/TuiInteractionInfrastructure.test.ts` 覆盖焦点、键盘、save/cancel、wizard、connector、Attach Shell 和 mouse hit region。
- validation: `pnpm --filter @portable-devshell/tui test`
- fix commit: this batch

### 13. protocol DTO / frame compatibility 未退回 newline JSON

- status: pass
- evidence: `packages/shared/src/protocol/frame/ProtocolFrameCodec.ts` 与 `packages/shared/src/protocol/frame/ProtocolFrameReader.ts` 实现 4-byte big-endian length-prefixed JSON frame；`packages/shared/test/unit/protocol/frame/ProtocolFrameCodec.test.ts` 与 `packages/shared/test/unit/protocol/frame/ProtocolFrameReader.test.ts` 通过；`packages/control/test/integration/ControlRpcServer.test.ts` 复用同一 unix socket connection 走 frame RPC。
- fix commit: none

### 14. multi-target worker 分发回归未被后续任务破坏

- status: pass
- evidence: `README.md` 明确代码支持 target probe / resolution / install，真实 release asset 以实际 release 为准；`.github/workflows/release-worker.yml` 构建并发布 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`；`packages/core/test/unit/WorkerTargetResolver.test.ts`、`packages/core/test/unit/LocalWorkerInstaller.test.ts`、`packages/core/test/unit/WorkerTransport.test.ts` 覆盖 canonical target mapping、release-backed asset resolution、target-specific install path、ssh/docker/podman probe/install。
- fix commit: this batch

### 15. 全链路 smoke 覆盖 control / CLI / worker / MCP 真实执行链路

- status: pass
- evidence: `bash acceptance/run-real-worker-smoke.sh` 启动真实 control、实例、worker，验证 `status`、`instance start`、`instance call`、`instance logs`、`instance.readToolCalls` 和 JSONL 持久化；`bash acceptance/run-mcp-smoke.sh` 通过真实 HTTP MCP endpoint 验证 `initialize`、`tools/list`、`tools/call` 和 workspace 路径。
- fix commit: this batch

### 16. 最终静态审查

- status: pass
- evidence: `README.md`、`ACCEPTANCE.md`、`acceptance/run-final-acceptance.sh` 与当前代码边界一致；TUI 证据只引用当前存在的 runtime、store、interaction、render 与测试文件；route、socket、approval、multi-target 说明均能在源码和测试中找到对应证据。
- fix commit: this batch

## Result

- overall: pass
- blockers remaining: none
