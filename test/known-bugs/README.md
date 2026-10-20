# Beta Known-Bug Reproductions

This directory contains deliberately **failing** tests for independently reproduced implementation defects. They are **not** part of the regular `pnpm test:packages`, `pnpm test:scripts` or Cargo discovery. A nonzero exit is expected **until the implementation is fixed**; do not change the assertions simply to make the tests green.

Run the remaining opt-in non-UI reproducers from the repository root:

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/*.test.ts
```

The third-round remaining cases cover two Extension lifecycle races, one Stream admission race, one OAuth refresh-token race, and two Reentry claim-ownership races. Fixed A/B cases have moved into their owning packages' default suites; this glob includes other unresolved rounds too.

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

# ApprovalService closure race (still RED)
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/core/test/RegisterWorkspacePackages.mjs --test test/known-bugs/ApprovalServiceCloseRound4.test.ts

# Comment/Mailing real SQLite and disk: duplicate, wrong scope, quoted ID, invalid sender
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./extensions/comment/test/RegisterWorkspacePackages.mjs --test --test-isolation=none test/known-bugs/CommentMailingDelivery.test.ts

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


## Sixth-round standalone regressions

The ToolCall Audit ownership and post-execution retry failures are now in default package discovery. Only the Reverse WSS candidate failure remains RED in this section.

```sh
# A failed WSS replacement must not poison the retained predecessor's reliable RPC session
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/ReverseCandidateFailurePoisonsPreviousRound6.test.ts
```

## Promoted A/B regressions (now in default package tests)

The original assertions are retained in their owning suites:

- Config recovery: `packages/control/test/unit/control/config/persistence/ConfigForeignDocument.test.ts` and `ConfigPostcommitCleanup.test.ts` in the same directory.
- Config commit/GC fault injection: `packages/control/test/unit/control/config/persistence/CommittedCleanup.test.ts`.
- Duplicate Audit ownership: `packages/control/test/integration/server/transport/ToolCallDuplicateAuditOwnershipRound6.test.ts`.
- Normal/stream delivery metadata: `packages/control/test/integration/server/transport/ToolCallDeliveryFailure.test.ts`.
- Post-execution retry and running cancellation: `packages/core/test/unit/tool/ToolCallAdapterRetryAfterCommitRound6.test.ts` and `ToolCallCancellationAfterEffect.test.ts`.
- SDK cancellation via localhost TCP: `packages/mcp/test/integration/McpNativeAbortAudit.test.ts`.

All run as part of `pnpm test:packages`. The ApprovalService close race remains in `test/known-bugs/ApprovalServiceCloseRound4.test.ts`.

Real positive acceptance programs:

```sh
pnpm acceptance:web             # Chromium Audit survives reload and WebUI Stop/Start
pnpm acceptance:tmux-handoff   # real 190-second task, 180-second detached handoff
pnpm stress:transport         # cgroup-bounded 32 MiB Artifact + eight Reverse cycles
```

The positive stress program now synchronizes the existing old-token-revocation assertion on the protocol's DSR2 ready/credential-commit event rather than the earlier Instance snapshot-ready boundary. This does not address the failed-candidate WSS session contamination regression.

## Seventh-round end-to-end RED chain reproducers

These complete Acceptance runs intentionally return nonzero on the current implementation. Each starts with genuinely working Rust/Control/MCP operations and reaches a product-level blocked state; they are **not part of default PR gates**.

```sh
# CLI + real Chromium Web + native Control + MCP Todo:
# after two meaningful Todo writes, the third revision probe is rejected by
# the Comment Extension's fixed two-access budget before CAS evaluation.
node acceptance/run-cross-client-chain-smoke.mjs

# Real Reverse Worker WSS, MCP bash_run and SQLite audit pass, but self-managed
# Worker stopped before Control delete still leaves old-generation cleanup debt
# after public retryCleanupDebt.
node acceptance/run-provider-chain-smoke.mjs

# Aggregate is nonzero until both blockers are resolved and the full chains pass.
# A failure in one chain must never suppress execution of the other chains.
node acceptance/run-chain-matrix.mjs --all
```

L07 Artifact and L05 Workflow are genuine full-chain **green** Acceptance programs. See `docs/development/functional-chain-acceptance.md` for the verified E2E boundaries, exact commands and what still requires a real ChatGPT Host or remote provider.
