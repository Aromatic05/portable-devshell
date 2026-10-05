import type { ContextEnvironmentCleanup, ContextRecord } from "../Model.js";

export interface ContextCleanupLedgerPort {
    listCleanupPending(): Promise<ContextRecord[]>;
    listEnvironmentCleanup(
        ctxId?: string,
    ): Promise<Array<{ cleanup: ContextEnvironmentCleanup; ctxId: string }>>;
    recordEnvironmentCleanup(
        ctxId: string,
        cleanup: ContextEnvironmentCleanup,
    ): Promise<void>;
    settleCleanup(ctxId: string): Promise<void>;
    settleEnvironmentCleanup(
        ctxId: string,
        cleanup: ContextEnvironmentCleanup,
    ): Promise<void>;
}
