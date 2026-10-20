# Round 4 D — Comment / Memory / Mailing

Scope: C21, C09, C25, X04. Test-only changes; no production implementation,
package configuration, lockfile, existing known-bug tests, or other agents' files
were edited. Product defects remain deliberately unfixed.

## Verified results

- **16 new passing tests**: 11 Memory/Mailing tests and 5 Comment lifetime/SQLite
  tests. All **128 Comment unit tests pass**, exit **0**, no skips.
- Four isolated expected-behavior reproducers: **4 failures / 4 tests**, exit **1**.
  They live outside the default `test/unit/*.test.ts` selection.
- Explicit Rust IPC integration: **0 pass / 1 failure**, exit **1**, environment
  blocked. An isolated Worker log records Unix socket bind `EPERM`; this is not
  counted as a product defect or as completed integration coverage.
- Scoped Comment test TypeScript check: exit **0**. Repository-wide test typecheck:
  exit **2**, with errors in other agents' MCP/Web test files, none in Comment.
- ESLint on all eight added TypeScript files: exit **0**.
- The existing package runner also exits **0**. In this workspace its process
  isolation reports file-level results; the explicit non-isolated invocation
  below exposes and verifies all 128 individual assertions.

Run from repository root:

```sh
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./extensions/comment/test/RegisterWorkspacePackages.mjs --test --test-isolation=none extensions/comment/test/unit/*.test.ts
```

Passing coverage uses production CommentService, MessageStore, MailingService,
WorkerMailingFiles and Protocol. SQLite is real, with WAL reopen and actual child
process exits at the queued/delivered commit boundaries (exit 23/24). A SQLite
trigger aborts the second delivery UPDATE to verify complete transaction/control
rollback before retry. Other tests verify admitted-writer retirement, independent
Instance databases, exact original strings and Context isolation.

The disk Worker capability adapter performs real filesystem reads, writes,
append+fsync and state-file replacement. It does **not** claim to implement Rust
snapshot conflict detection, host session lifecycle, or OS crash durability. A
separate real Rust/IPC helper and integration target have no substitute backend.
The Context registry is a controlled capability fixture, not a real TTL registry.

Memory coverage includes idempotent init, live-owner transfer, release/reinherit,
restart discovery, arbitrary unstructured files, 12 simultaneous scans, 6
simultaneous consumers, unfinished outbox completion, interruption before inbox
write, lost response after inbox commit, failed notification admission/restart,
expired owners with deferred notices, simultaneous inheritance, close/drain and
malformed-sender isolation. Original chat/mail bodies remain intact.

## Confirmed defects

All four failures occur in production dispatch/dedup logic over real disk state
and real SQLite, not canned Comment responses. Source lines refer to the
unchanged production tree inspected this round.

| ID | Source | Trigger | Actual | Expected |
| --- | --- | --- | --- | --- |
| R4-D1 | `src/mailing/Service.ts:325-328`, `:336-341`; `src/comment/CommentService.ts:43-48` | Commit notification to SQLite; fail Mailing acknowledgement write; reopen both services and SQLite | Inbox has one original; Comment history has **two** notifications | One durable notification for one mail across restart |
| R4-D2 | `src/mailing/Service.ts:337-338`, `:325-328` | Same Context attached to two Instances; same sender/mail ID in both independent workspaces | First scope receives notification; second scope receives **zero**, but its durable pending notice is deleted | Both scope-local notices delivered |
| R4-D3 | `src/mailing/Store.ts:115-117`; `src/mailing/Service.ts:306-315` | First message body quotes the marker of the following real message | Second original absent from inbox although both accepted and both notifications queued | Quoted body text cannot replace a complete delivery record |
| R4-D4 | `src/mailing/Service.ts:288-289`, `:318` | Mutate an already accepted outbox while notices are pending; add another valid sender | Scan throws before flushing existing notices or processing the other sender; **zero** notices | Isolate invalid sender and preserve independent delivery/progress |

Deterministic failing command, exit **1**, **4 failures**:

```sh
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --import ./extensions/comment/test/RegisterWorkspacePackages.mjs --test --test-isolation=none extensions/comment/test/known-bugs/MemoryDelivery.test.ts
```

The required retained artifact entry point is
`var/agent-work/beta-matrix-round4/D-comment-memory/reproduce.mjs`. Run the same
command replacing the final test filename with that artifact path. Its verified
result is also exit **1**, four assertion failures. That directory contains full
passing-suite, reproducer, IPC, lint and typecheck logs plus a copy of this report.
The artifact imports the owned test source so there is only one maintained
implementation of each reproducer.

## Files added

- `extensions/comment/test/unit/MemoryDurability.test.ts`
- `extensions/comment/test/unit/CommentLifetimeDurability.test.ts`
- `extensions/comment/test/helpers/DiskWorker.ts`
- `extensions/comment/test/helpers/DiskMemory.ts`
- `extensions/comment/test/helpers/CommentCrashProcess.ts`
- `extensions/comment/test/helpers/RealMemory.ts`
- `extensions/comment/test/integration/MemoryIpc.test.ts`
- `extensions/comment/test/known-bugs/MemoryDelivery.test.ts`
- `extensions/comment/test/known-bugs/ROUND4-D-REPORT.md`

## Still uncovered

1. Successful Rust Worker IPC execution, real snapshot conflict/cancellation and
   host-managed session teardown. The retained integration command is the unit
   command above with final path `extensions/comment/test/integration/MemoryIpc.test.ts`.
2. Actual power loss, fsync/rename failure, ENOSPC and torn SQLite/filesystem pages.
   Rust's anchored publishing path calls `sync_all`, renames, then `sync_parent`
   (`crates/devshell-worker/src/tool/file/edit/publish.rs:173-200`); those syscall
   failure boundaries were inspected, not fault-injected. Lost-response tests
   cover completed append commits, not physical partial writes.
3. Independent live Control processes writing one physical workspace, including
   workspace aliases and two Workers sharing the same on-disk mailbox/state.
4. Real Context TTL/mask/disable events racing after the active-owner snapshot,
   or Instance retirement while a Worker edit or notification is in flight.
5. HTTP/MCP/browser notification presentation and cancellation, reverse Worker
   reconnects, Windows/macOS filesystem semantics.
6. Worker file_read pagination and 8 MiB archival boundaries with accumulated mail.

Outstanding product risk: the four confirmed defects above. No claim of a
production fix or zero remaining product risk is made.
