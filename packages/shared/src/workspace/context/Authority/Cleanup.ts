import type { McpContextEnvironmentCleanup, McpContextRecord } from "../Model.js";

export interface ContextCleanupLedgerPort {
    listCleanupPending(): Promise<McpContextRecord[]>;
    listEnvironmentCleanup(ctxId?: string): Promise<Array<{ cleanup: McpContextEnvironmentCleanup; ctxId: string }>>;
    recordEnvironmentCleanup(ctxId: string, cleanup: McpContextEnvironmentCleanup): Promise<void>;
    settleCleanup(ctxId: string): Promise<void>;
    settleEnvironmentCleanup(ctxId: string, cleanup: McpContextEnvironmentCleanup): Promise<void>;
}
