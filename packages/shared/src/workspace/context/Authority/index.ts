export type { ContextRecordPort } from "./Record.js";
export type { ContextReentryPort } from "./Reentry.js";
export type { ContextCleanupLedgerPort } from "./Cleanup.js";
import type { ContextRecordPort } from "./Record.js";
import type { ContextReentryPort } from "./Reentry.js";
import type { ContextCleanupLedgerPort } from "./Cleanup.js";

export interface ContextRegistryPort extends
    ContextRecordPort,
    ContextCleanupLedgerPort {
    readonly reentry: ContextReentryPort;
}
