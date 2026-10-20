# Beta Reproduction and Regression Registry

This directory preserves opt-in probes and links to former RED assertions. After the 2026-10-20 beta repair batches, the original A–H scenarios are fixed in their owning package suites. **Do not treat the historical RED labels in test names or the round-by-round finding log as the current result.** Keep original causal assertions intact when promoting a regression; never use skip/todo or weaker timing to make a case green.

## Remaining opt-in native Worker reproductions

Two expensive native cleanup scenarios remain outside regular package discovery but **passed** in an isolated host environment after the retirement repair:

```sh
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./packages/mcp/test/RegisterWorkspacePackages.mjs --test test/known-bugs/ControlCleanupRetryRound5.test.ts test/known-bugs/WorkerRetireStalePidRound5.test.ts
```

They use temporary home directories and real Rust/Control IPC. They must not be pointed at running user instances.

## Promoted normal package regressions

| Area | Original fault now covered in default discovery |
|---|---|
| Config A | `packages/control/test/unit/control/config/persistence/{ConfigForeignDocument,ConfigPostcommitCleanup,CommittedCleanup}.test.ts` |
| ToolCall B | `packages/control/test/integration/server/transport/{ToolCallDuplicateAuditOwnershipRound6,ToolCallDeliveryFailure}.test.ts`; `packages/core/test/unit/tool/{ToolCallAdapterRetryAfterCommitRound6,ToolCallCancellationAfterEffect}.test.ts`; `packages/mcp/test/integration/McpNativeAbortAudit.test.ts` |
| OAuth C | `packages/mcp/test/integration/{OAuthRefreshRaceRound3,OAuthRefreshConcurrentReplayRound5,OAuthMigration,OAuthRefreshRestart}.test.ts`; `packages/mcp/test/unit/auth/OAuthRefresh.test.ts` |
| Reentry C | `packages/mcp/test/unit/mcpapp/{ReentryClaimOwnershipRound3,ReentryClaimOwnership}.test.ts` |
| Container adoption D | `packages/core/test/unit/worker/provision/{ProviderAdoptionRuntime,Existing,ExistingIntegration}.test.ts` |
| Reverse WSS D | `packages/control/test/integration/{ReverseCandidateFailurePoisonsPreviousRound6,ReverseCandidateIsolation}.test.ts` |
| Extension E | `packages/control/test/integration/extension/{ExtensionLifecycleRace,ExtensionStreamAdmission}.test.ts` and retirement/generation tests |
| Mailing F | `extensions/comment/test/integration/MailingKnownBugs.test.ts` and `extensions/comment/test/unit/{MailingRecovery,MailingMigration,CommentMailingProducer}.test.ts` |
| Todo/Approval G | `extensions/comment/test/unit/TodoAccess.test.ts`; `packages/core/test/unit/approval/{CloseRound4,Close}.test.ts` |
| TUI H | `packages/tui/test/interaction/{TuiOverlayLifetime,Overlay}.test.ts` |
| MCP App/Web H | MCP App `AppRaces.test.tsx`, Web Config/Audit state tests and component RED files below |

Run the applicable packages through `pnpm test:packages`. For historical bug details see `docs/development/beta-bug-findings.md`.

## Opt-in rendered UI reproductions

These are component-boundary tests with real React rendering and controlled Host/domain inputs; all original cases were green after their corresponding changes. They do not by themselves prove live Chromium or ChatGPT Host integration:

```sh
node packages/web/node_modules/vitest/vitest.mjs run --config test/known-bugs/ui/web-repro.config.ts
node packages/web/node_modules/vitest/vitest.mjs run --config test/known-bugs/ui/web-round4-repro.config.ts
node packages/mcpapp/node_modules/vitest/vitest.mjs run --config test/known-bugs/ui/mcpapp-repro.config.ts
node packages/mcpapp/node_modules/vitest/vitest.mjs run --config test/known-bugs/ui/mcpapp-round5-repro.config.ts
```

Two speculative Web Config navigation assertions were removed in the earlier investigation after a real parent remount disproved the proposed failure; they are not counted as confirmed defects.

## Isolated full-chain acceptance

```sh
node acceptance/run-provider-chain-smoke.mjs       # L01/L04 real Reverse Rust Worker, passed after repair
node acceptance/run-cross-client-chain-smoke.mjs   # L03 CLI/Chromium/MCP/Todo/Approval
node acceptance/run-chain-matrix.mjs --all          # L07/L05 plus the above; preserve nonzero exit
```

The 2026-10-20 host L01/L04 run completed with exit 0: enrollment, network recovery, durable audit, debt-free delete and same-name re-creation. After the Web pending-approval fix and fresh production Web build, L03 completed **all six chains**, exit 0 and cleanup completed: real CLI/MCP/Worker, failed-Web-RPC recovery, Todo revision conflicts and hard reload, **Web Approval before any ToolCall audit row**, stream gap recovery, and durable final state after Control restart. A separate actual Chromium test in `packages/web/test/browser/PendingApprovals.chromium.mjs` also passed pre-execution Approve and Deny without fabricating audit records. The full `acceptance/run-chain-matrix.mjs --all` then passed **4/4** real chains (L07, L05, L03, L01-L04) with zero failures and exit 0. The L03 report explicitly does not exercise TUI.

Use a fresh isolated Testspace root for `pnpm testspace recovery-smoke` or `pnpm testspace retirement-smoke` if needed, and always run `pnpm testspace stop`. Never run those scripts on shared `.testspace`, production Control or user `~/.devshell` directories. Older positive manual runs also include `pnpm acceptance:web`, `pnpm acceptance:tmux-handoff` and `pnpm stress:transport`.
