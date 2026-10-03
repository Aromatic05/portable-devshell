import type { GoalActivityKind } from "../../task/Model.js";
import type {
    McpContextAutomaticReentryMode,
    McpContextAutomaticReentrySourceKind,
    McpContextAutomaticReentryState,
} from "../Model.js";

export interface ContextReentryPort {
    readAutomaticReentry(ctxId: string, instance: string): Promise<McpContextAutomaticReentryState>;
    suppressAutomaticReentry(ctxId: string, instance: string, reason: string, mode?: Exclude<McpContextAutomaticReentryMode, "automatic">): Promise<McpContextAutomaticReentryState>;
    resumeAutomaticReentry(ctxId: string, instance: string): Promise<McpContextAutomaticReentryState>;
    observeAutomaticReentryActivity(ctxId: string, instance: string, activity: GoalActivityKind): Promise<McpContextAutomaticReentryState>;
    observeExecutionActivity(ctxId: string, instance: string): Promise<McpContextAutomaticReentryState>;
    releaseExecutionActivity(ctxId: string, instance: string, expectedEpoch: number): Promise<McpContextAutomaticReentryState>;
    markAutomaticReentryAttempted(ctxId: string, instance: string, claimId: string): Promise<McpContextAutomaticReentryState>;
    markAutomaticReentryAccepted(ctxId: string, instance: string, claimId: string): Promise<McpContextAutomaticReentryState>;
    markAutomaticReentryRejected(ctxId: string, instance: string, claimId: string): Promise<McpContextAutomaticReentryState>;
    claimAutomaticReentry(ctxId: string, instance: string, claimId: string): Promise<{ claimed: boolean; state: McpContextAutomaticReentryState }>;
    bindAutomaticReentrySource(
        ctxId: string,
        instance: string,
        claimId: string,
        sourceKind: McpContextAutomaticReentrySourceKind,
        sourceId: string,
    ): Promise<McpContextAutomaticReentryState>;
    validateAutomaticReentry(ctxId: string, instance: string, claimId: string): Promise<{ state: McpContextAutomaticReentryState; valid: boolean }>;
    releaseAutomaticReentry(ctxId: string, instance: string, claimId: string): Promise<McpContextAutomaticReentryState>;
    clearAutomaticReentryClaim(ctxId: string, instance: string): Promise<McpContextAutomaticReentryState>;
    listAutomaticReentryClaimsForInstance(instance: string): Promise<Array<{
        attempted: boolean;
        claimId: string;
        ctxId: string;
        sourceId?: string;
        sourceKind?: McpContextAutomaticReentrySourceKind;
    }>>;
}
