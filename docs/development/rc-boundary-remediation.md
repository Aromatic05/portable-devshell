# RC execution, transport, recovery remediation (2026-10-28)

Baseline: `main@2d55ffd2`, DevShell 1.0.0-rc.2. Evidence: `var/agent-work/rc-release-boundary-review-20261028/SUMMARY.md`, with A/B/C details. Independent coordinator source verification found the reported code paths still present; actual effect/frequency of conditional cases needs focused tests, not assumptions.

## Scope and guarantees

Resolve seven existing P1 mechanisms and four P2s, with the narrowest change per case. Remove stale or misleading code before introducing replacement controls; no speculative compatibility glue, architecture migrations, or changes to authenticated Host scope. Trust local persisted credentials as decided; actual MCP content escaping an outbound Rewrite is in scope. A cancel before an irreversible effect should prevent it; after an effect, return explicit uncertainty, never replay automatically. Preserve Stream half-close, lawful Host native MCP presentation, and notification/replay sequence semantics.

## Execution sequence

1. **Commit plan first**, leaving an otherwise clean tree.
2. Parallel agents in **one repo, no worktrees**. Strict file ownership, agents DO NOT commit/rebase/reset/checkout/stash or install or restart running DevShell instances. Agents write code and focused tests only in assigned areas, run local targeted tests/build checks and report results. Source cross-reads allowed, cross-owner writes forbidden.
3. Owners (six independent lanes):
   - **A approval**: `packages/core/src/approval/**`, `packages/shared/src/approval/**`, `packages/shared/src/execution/toolcall/Route.ts`, `packages/tui/**`, `packages/web/src/view/page/activity/audit/approval/**`, `packages/mcp/src/mcpapp/ViewModel.ts`, corresponding approval/Route/TUI tests. RC-01 full review input, RC-02 RPC cancellation, A-04 caller approval visibility. Web Audit top-level page belongs to F and should display complete approval request if available.
   - **B MCP outcome**: `packages/core/src/toolcall/execution/**`, `packages/control/src/extension/api/point/mcp/**`, `packages/mcp/src/protocol/**` and adjacent targeted tests, and `packages/shared/src/execution/toolcall/Type.ts` if wire typing demands. RC-03 both legal native MCP textual and structured results subject to outbound Rewrite; never modify review ordering or blanket-drop native presentation.
   - **C Rust Worker**: `crates/devshell-worker/src/transport/reverse/**`, `crates/devshell-worker/src/transport/endpoint/**`, `crates/devshell-worker/src/capability/rpc/notification.rs`, `crates/devshell-worker/src/capability/terminal/**` only, matching Rust tests. RC-05 WSS/proxy TLS/Upgrade full-attempt timeout, blocking write; RC-06 bounded terminal notification pending. Must NOT rework already bounded ordinary process ByteStream.
   - **D JS Transport**: `packages/shared/src/transport/**`, `packages/shared/src/client/Stream.ts`, corresponding tests (excluding `shared/src/execution/**` and `shared/src/workspace/**`). RC-07 Packet and Event logical consumer bounded queues plus B-01 blocked send/remote FIN close convergence. Distinguish legitimate slow reader vs closed/cancelled.
   - **E Windows migration**: `scripts/install-release.ps1` and related Windows-specific installer tests under `scripts/`/test paths. RC-04 partial durable migration, safe generation rollback. Must preserve candidate if migration may have changed data; no fake Windows runtime test on Linux.
   - **F Web history**: `packages/web/src/view/page/activity/messages/**`, `packages/web/src/view/page/activity/audit/Page.tsx`, `packages/shared/src/workspace/message/**`, `packages/shared/src/execution/toolcall/ViewModel.ts`, relevant Web tests. C-01 cancellable/timeout history export and audit read; C-02 all-instance partial failures. Additionally surface A's complete review input in Web Audit Page once contract exists; ensure no raw protocol implementation hints. No new web UI architecture.
4. Integration controller resolves cross-lane type contracts, verifies patches and actual test outcomes, runs package/whole-repo checks plus protocol stress/failure tests as feasible, then commits by scope in linear history and finishes with clean tree. Missing native Windows or real ChatGPT Host acceptance must be explicitly reported; no release/upgrade/push unless separately requested.

## Primary acceptance tests

- Approval long input tail visible before decision in Web, TUI and MCP App; RPC cancel/disconnect during ask prevents executor and late approval.
- Valid MCP extension structured+native text sentinel is covered by Rewrite and Host output, with Review/Rewrite contract preserved.
- Terminal output with zero Frame WINDOW remains bounded; WSS proxy CONNECT-then-blackhole and Upgrade stall fail by deadline and allow retry/SSE; blocking WSS send fails instead of permanently hanging.
- Packet/Event reader stalls cannot grow unbounded and sibling stream remains live; FIN plus stalled write closes cleanly.
- Windows child dies after first schema commit: no unsafe old-code rollback (or safely restored data snapshot); tests must not claim native Windows execution without Windows.
- Web second page never completes: cancellation/timeouts end pending without partial export; alpha page fails but beta records are still searched and surfaced.

All tests must preserve existing accepted architecture and explain any intentionally unsupported case. No speculative version/install status commentary.
