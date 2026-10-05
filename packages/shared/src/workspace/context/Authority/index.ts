export type { ContextRecordPort } from "./Record.js";
export type { ContextCleanupLedgerPort } from "./Cleanup.js";
import type { ContextRecordPort } from "./Record.js";
import type { ContextCleanupLedgerPort } from "./Cleanup.js";

export interface ContextRegistryPort extends
    ContextRecordPort,
    ContextCleanupLedgerPort {}
