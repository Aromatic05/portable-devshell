# RC UI/HCI remediation plan (2026-10-28)

Baseline: `main@5dec849f`, `1.0.0-rc.2`. Inputs: `var/agent-work/ui-leakage-audit-20261028/summary.md` and its three source reports.

## Contract

Remove implementation trivia from the everyday UI and restore honest, actionable status. Developer concepts and opt-in diagnostics remain available; do not conceal errors needed to troubleshoot. Preserve underlying side-effect and recovery safeguards. Never turn an unconfirmed result into success or failure.

## Sequence: delete, then implement

1. **Delete obsolete UI copy first.** Remove the always-visible incomplete Markdown export warning, always-visible Inline card lifecycle explanation, exposed tool-specific `nextSelector`/cursor/`resultDetail` instructions, default view `revision`/`sequence`, the misleading TUI fixed `namespaceAuth valid` box, and the MCP App server/Host implementation tooltip. Keep the actual export incompleteness acknowledged in export action feedback until behavior is repaired. Commit the deletion-only change before implementing replacements.
2. **Implement three independent lanes in one repository, without worktrees:**
   - **Web owner** `packages/web/**`, related `packages/shared/src/workspace/message/**`, `packages/shared/src/control/overview/**`: W01-W10. Honest audit search/history, direct-read errors, actual vs pending connection endpoints, Control host naming, state unknown vs stopped, timeout uncertain presentation, export correctness or explicit choice, unified feedback, unsupported Overview. Test Web sources in `packages/web/test/**`.
   - **TUI/CLI owner** `packages/tui/**`, related TUI tests: T01-T06. Correct cross-instance error surface, cleanup-pending feedback, OAuth mode/approval unknown state, load older shortcut, validation status. CLI internals need no speculative rewriting.
   - **MCP App/Host owner** `packages/mcpapp/**`, `packages/mcp/**`, `packages/control/src/server/web/auth/OAuth.ts`, related tests: M01-M07. Browser OAuth error page instead of raw JSON on browser navigation, honest snapshot/connection headers, actionable error mapping, uncertain Goal reentry, rendering of unavailable continuation/diff without telling user protocol parameters. Preserve all security and protocol semantics. No cross-lane edits to other owners' files.
3. **Integrate:** Review diffs for net simplicity, deduplicate cases, fix tests whose old assertions enshrined bad UI, run focused test suites, source typecheck and lint, then CI-relevant checks if practical. Central controller alone commits, by scoped lane in linear order; subagents must not commit, reset, checkout, rebase, stash, install, or create worktrees.

## Guardrails

- Only actual user-visible behavior. No architecture migrations, compatibility shims or speculative safeguards.
- Same-commit clean tree once complete. Do not introduce new raw implementation terminology while fixing other copy.
- Status is one of loading / known-empty / unavailable / failed / uncertain as appropriate. Do not silently promise complete exports or global searches if still scoped.
- Native platform/live Host coverage may remain manual acceptance gaps and must be reported separately.
