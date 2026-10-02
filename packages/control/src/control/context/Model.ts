import type {
    McpContextAutomaticReentryMode,
    McpContextAutomaticReentrySourceKind,
    McpContextExternalBinding,
    McpContextEnvironmentCleanup,
} from "@portable-devshell/shared";
import type { McpContextRecord } from "@portable-devshell/shared";

export type {
    McpContextAutomaticReentryMode,
    McpContextAutomaticReentrySourceKind,
    McpContextAutomaticReentryState,
    McpContextBinding,
    McpContextEnvironmentBinding,
    McpContextExternalBinding,
    McpContextInstanceReference,
    McpContextMaskedInstance,
    McpContextQuery,
    McpContextEnvironmentCleanup,
    McpContextValidationBinding,
    McpContextRecord,
} from "@portable-devshell/shared";

export const defaultMcpContextTtlMs = 24 * 60 * 60 * 1_000;
export const defaultMcpContextTerminalHistory = 256;

export interface McpContextRemoteInstanceHandle {
    handle: string;
    instance: string;
}

export interface McpContextStoredRecord extends McpContextRecord {
    cleanupPending?: boolean;
    executionEpoch?: number;
    executionLastActivityAt?: string;
    executionLeaseUntil?: string;
    automaticReentryAttemptedAt?: string;
    automaticReentryClaimedAt?: string;
    automaticReentryClaimId?: string;
    automaticReentryInstance?: string;
    automaticReentryEpoch?: number;
    automaticReentryMode?: Exclude<McpContextAutomaticReentryMode, "automatic">;
    automaticReentrySuppressedAt?: string;
    automaticReentrySuppressionReason?: string;
    automaticReentrySourceId?: string;
    automaticReentrySourceKind?: McpContextAutomaticReentrySourceKind;
    externalBindings?: McpContextExternalBinding[];
    maskedInstances?: string[];
    pendingEnvironmentCleanup?: McpContextEnvironmentCleanup[];
    remoteInstanceHandles?: McpContextRemoteInstanceHandle[];
}

export const AUTOMATIC_REENTRY_CLAIM_TTL_MS = 2 * 60_000;
export const MCP_CONTEXT_EXECUTION_LEASE_MS = 60 * 1_000;

export interface McpContextRegistryOptions {
    executionFilePath?: string;
    filePath?: string;
    idFactory?: () => string;
    maxTerminalContexts?: number;
    now?: () => number;
    ttlMs?: number;
}

export interface McpContextDocument {
    contexts: McpContextStoredRecord[];
    version: 2;
}
