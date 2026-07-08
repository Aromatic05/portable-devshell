# Task 13 Acceptance

## Commands

- `bash acceptance/run-typecheck.sh`
- `bash acceptance/run-unit-tests.sh`
- `bash acceptance/run-real-worker-smoke.sh`
- `bash acceptance/run-mcp-smoke.sh`

## Acceptance Checks

### 1. control 是长期运行 server

- status: pass
- evidence: `packages/control/test/integration/ControlRealWorker.test.ts` test `control lifecycle smoke drives the frozen worker and persists Task 12 artifacts`; `bash acceptance/run-real-worker-smoke.sh` produced `control: running` before any instance start.
- fix commit: none

### 2. cli 不会自动拉起 control

- status: pass
- evidence: `packages/cli/test/integration/CliControl.test.ts` test `CliMain reports control not running without auto-starting it`.
- fix commit: none

### 3. cli 不直接读取文件系统状态

- status: pass
- evidence: `packages/cli/test/integration/CliControl.test.ts` test `CliControlClient performs control rpc over unix socket`; `rg -n "spawn|execFile|child_process|node:fs|readFile|writeFile|mkdir|readdir|stat" packages/cli/src` returned no matches.
- fix commit: none

### 4. cli 不直接 spawn devshell-worker

- status: pass
- evidence: `packages/cli/test/integration/CliInstance.test.ts` test `CliMain covers Task 11 instance commands through control rpc`; `rg -n "spawn|execFile|child_process" packages/cli/src` returned no matches.
- fix commit: none

### 5. control 不提供 global logs/global timeline/global tool calls

- status: pass
- evidence: `packages/control/src/route/RouteMethodRegistry.ts` only registers `control.ping`, `control.status`, `control.shutdown`, `control.listInstances`, `instance.getSnapshot`, `instance.start`, `instance.stop`, `instance.refreshStatus`, `instance.readLogs`, `instance.subscribe`, `instance.callTool`; `packages/control/test/unit/RouteRouter.test.ts` test `RouteMethodRegistry resolves Task 9 methods only`.
- fix commit: none

### 6. core 长期持有 worker rpc bridge

- status: pass
- evidence: `packages/core/test/unit/WorkerRpc.test.ts` test `WorkerRpcBridge reuses one spawned rpc process across multiple calls`; `packages/core/test/integration/WorkerInstanceReal.test.ts` test `WorkerInstance completes lifecycle against frozen devshell-worker`.
- fix commit: none

### 7. core 不自动 start stopped/stale instance

- status: pass
- evidence: `packages/control/test/unit/ControlLifecycle.test.ts` test `start keeps real worker config registered and does not auto-start worker`; `bash acceptance/run-real-worker-smoke.sh` returned `status: stopped` before explicit `devshell instance start aromatic-pc`.
- fix commit: none

### 8. MCP 不暴露 instances 控制面

- status: pass
- evidence: `packages/mcp/src/mcp/host/route/McpHostRouteMatcher.ts` only matches `/<instance>/mcp`; `packages/mcp/src/mcp/host/route/McpHostRouteRegistry.ts` registers bindings by instance name only; `packages/mcp/test/integration/McpHttpServer.test.ts` test `missing instance returns 404`.
- fix commit: none

### 9. MCP 公网无鉴权会启动失败

- status: pass
- evidence: `packages/mcp/test/unit/McpAuth.test.ts` tests `listenHost=0.0.0.0 plus auth none is rejected` and `publicBaseUrl outside localhost plus auth none is rejected`; `packages/control/test/unit/ControlConfig.test.ts` test `public MCP without auth is rejected`.
- fix commit: none

### 10. 同一 instance 不支持并发 tool call

- status: pass
- evidence: `packages/core/test/integration/WorkerInstanceReal.test.ts` test `WorkerInstance rejects not-ready and concurrent tool calls while persisting history`.
- fix commit: none

### 11. control RPC 没有退回 newline JSON

- status: pass
- evidence: `packages/shared/src/protocol/frame/ProtocolFrameCodec.ts` encodes and decodes 4-byte big-endian length-prefixed JSON frames; `packages/shared/test/unit/protocol/frame/ProtocolFrameCodec.test.ts` and `packages/shared/test/unit/protocol/frame/ProtocolFrameReader.test.ts` passed via `bash acceptance/run-unit-tests.sh`; `packages/control/test/integration/ControlRpcServer.test.ts` test `ControlRpcServer serves Task 9 rpc methods over reused unix socket connection`.
- fix commit: none

### 12. snapshot/stream 支持 seq/fromSeq

- status: pass
- evidence: `packages/control/test/unit/StreamSubscription.test.ts` tests `StreamSubscriptionManager returns snapshot lastSeq and pushes sequenced events` and `StreamSubscriptionManager returns stream.gap when fromSeq is unavailable`; `packages/core/test/unit/LogStore.test.ts` test `InstanceEventBuffer replays from fromSeq and reports stream.gap`.
- fix commit: none

### 13. TS storage 与 worker storage 不冲突

- status: pass
- evidence: `packages/core/src/instance/InstancePaths.ts` writes TS-side data only to `~/.devshell/<instance>/control-worker/{events,tool-calls,logs}.jsonl` while worker files remain under `~/.devshell/<instance>/{config.toml,logs/worker.log,state/worker.pid}`; `packages/core/test/unit/InstanceState.test.ts` test `InstancePaths writes only into per-instance control-worker files`; `bash acceptance/run-real-worker-smoke.sh` verified `control-worker/tool-calls.jsonl`, `control-worker/events.jsonl`, and `control-worker/logs.jsonl`.
- fix commit: none

### 14. worker workspace 没有写入 worker config

- status: pass
- evidence: `packages/core/src/worker/command/WorkerCommandClient.ts` passes `workspacePath` only to worker start command; `packages/core/src/worker/transport/driver/WorkerTransportDriverLocal.ts` maps that workspace to `cwd` for `start` instead of writing config; `acceptance/fixtures/config.local.toml` stores workspace in TS control config as `defaultWorkspace`; `bash acceptance/run-real-worker-smoke.sh` and `bash acceptance/run-mcp-smoke.sh` confirmed runtime `pwd` equals the temporary workspace path.
- fix commit: none

### 15. tools schema 来自 worker tools.list

- status: pass
- evidence: `packages/core/test/unit/WorkerRpc.test.ts` test `WorkerProtocolClient performs ping, handshake, and tools.list against frozen devshell-worker`; `packages/core/test/unit/ToolPolicy.test.ts` tests `WorkerToolCatalog filters tools through allowlist and resets on clear` and `WorkerToolCatalog rejects invalid tool schema from tools.list`; `bash acceptance/run-mcp-smoke.sh` returned `toolsList.result.tools[0].name = "bash_run"`.
- fix commit: none

### 16. worker binary install 按 target 探测与分发

- status: pass
- evidence: `packages/core/src/worker/target/WorkerTargetProbe.ts` probes local via `process.platform/process.arch` and probes ssh/docker/podman via `uname -s` + `uname -m`; `packages/core/src/worker/WorkerAssetResolver.ts` resolves `packages/core/assets/workers/<targetKey>/devshell-worker` and returns `core.workerAssetUnavailable` when the target asset is missing; `packages/core/src/worker/install/{LocalWorkerInstaller,RemoteWorkerInstaller}.ts` install into `~/.devshell/workers/<targetKey>/<sha256>/devshell-worker`; `packages/core/assets/workers/{linux-x64,linux-arm64,darwin-x64,darwin-arm64}/devshell-worker` are present in the repo snapshot; `packages/core/test/unit/WorkerTargetResolver.test.ts`, `packages/core/test/unit/LocalWorkerInstaller.test.ts`, and `packages/core/test/unit/WorkerTransport.test.ts` cover canonical target mapping, target-aware asset resolution, ssh/container probe ordering, and target-specific remote install paths.
- fix commit: pending

## Result

- overall: pass
- blockers remaining: none
