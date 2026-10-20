# Beta Known-Bug Reproductions

This directory contains deliberately **failing** tests for independently reproduced implementation defects. They are **not** part of the regular `pnpm test:packages`, `pnpm test:scripts` or Cargo discovery. A nonzero exit is expected **until the implementation is fixed**; do not change the assertions simply to make the tests green.

For the eight confirmed non-UI defects, run from the repository root:

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/*.test.ts
```

This invokes 9 failing scenarios: two foreign instance TOML filenames, one post-commit cleanup failure, two Extension lifecycle races, one Stream admission race, one OAuth refresh-token rotation race, and two Reentry claim-ownership races.

For component-boundary UI findings (real rendered components with stubbed Host/domain connections):

```bash
node packages/web/node_modules/vitest/vitest.mjs run --config test/known-bugs/ui/web-repro.config.ts
node packages/mcpapp/node_modules/vitest/vitest.mjs run --config test/known-bugs/ui/mcpapp-repro.config.ts
```

These contain 4 Web and 4 MCP App expected-failing cases. They do not establish real ChatGPT Host or production data-path failure. Two speculative Web Config navigation cases were explicitly removed from the retained reproducible set after parent remount behavior disproved the initial hypothesis.

When fixing a bug, run its reproduction first. Once it passes, move it into the owning package's normal regression suite and update `docs/development/beta-bug-findings.md`. Avoid adding `skip`/`todo` markers to hide an open defect.


## Fourth-round explicit regressions

These tests are **expected to fail** and are not discovered by any default package or Rust suite. Fix the implementation first and then promote the unchanged assertion to the owning package's ordinary tests.

```sh
# Provider adopted container state is lost across runtime reconstruction
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/ProviderAdoptionRuntime.test.ts

# Control Call and Stream error metadata + ApprovalService closure race
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/core/test/RegisterWorkspacePackages.mjs --test test/known-bugs/ToolCallAuditBoundary.test.ts

# Comment/Mailing real SQLite and disk: duplicate, wrong scope, quoted ID, invalid sender
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./extensions/comment/test/RegisterWorkspacePackages.mjs --test --test-isolation=none test/known-bugs/CommentMailingDelivery.test.ts

# Native MCP cancellation audit; real SDK/OIDC/SQLite, simulated HTTP (not TCP)
ROUND4_MCP_TRANSPORT=memory TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/McpNativeAbortAudit.test.ts

# Four Web UI and three TUI Overlay rendering/state-machine regressions
node packages/web/node_modules/vitest/vitest.mjs run --config test/known-bugs/ui/web-round4-repro.config.ts
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/TuiOverlayLifetime.test.ts
```

### Running-system recovery reproduction

For the Control/Worker restart, 262 revision stream and failed committed-delete cleanup retry, set a **brand-new** private Testspace root, start, run `pnpm testspace recovery-smoke`, and always call `pnpm testspace stop` even if it fails. This test currently observes `cleanupPending=true` and a persistent old-Generation debt after public retry. See `docs/development/beta-bug-findings.md`. Never run this restart smoke on shared `.testspace` or live production Control.


## Fifth-round opt-in regressions

The following tests are **deliberately red** until product behavior is repaired; run these individually. They are excluded from the normal package and Rust test discovery.

```sh
# Real Control Unix IPC + real Rust Worker stale PID across Control restart
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/ControlCleanupRetryRound5.test.ts

# Isolated native Worker retire and Cleanup Debt after process state becomes stale
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/WorkerRetireStalePidRound5.test.ts

# Real TCP/OAuth concurrent refresh replay; one failed reuse does not revoke issued successor
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/McpRefreshConcurrentReplayRound5.test.ts

# Two real React red regressions: foreign Context reentry claim and stale snapshot overwrite
node packages/mcpapp/node_modules/vitest/vitest.mjs run --config test/known-bugs/ui/mcpapp-round5-repro.config.ts
```

For the isolated positive three-phase running-system retirement proof, start a *fresh* dedicated Testspace root, run `pnpm testspace retirement-smoke`, and always run `pnpm testspace stop` (even on failures). It verifies never-started deletion, explicitly stopped Worker deletion, and Control-restarted Worker stopped before deletion, with debt-free same-name recreation. This is not a permanent fix for the automatic cleanup retry RED.

