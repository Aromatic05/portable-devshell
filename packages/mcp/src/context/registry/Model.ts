import type {
    McpContextEnvironment,
    McpContextRecord,
} from "@portable-devshell/shared";

export type { McpContextRecord } from "@portable-devshell/shared";

export const defaultMcpContextTtlMs = 24 * 60 * 60 * 1_000;
export const defaultMcpContextTerminalHistory = 256;

export interface McpContextBinding {
    instance: string;
    principal: string;
    temporaryDirectory?: string;
    workspace: string;
}

export interface McpContextEnvironmentBinding {
    instance: string;
    temporaryDirectory?: string;
    workspace?: string;
}

export interface McpContextValidationBinding {
    principal: string;
}

export interface McpContextExternalBinding {
    kind: string;
    value: string;
}

export interface McpContextInstanceReference {
    current: boolean;
    handle?: string;
}

export interface McpContextMaskedInstance {
    environment?: McpContextEnvironment;
    instance: string;
}

export interface McpContextRemoteInstanceHandle {
    handle: string;
    instance: string;
}

export type McpContextAutomaticReentryMode =
    "automatic" | "user_owned" | "paused";

export interface McpContextStoredRecord extends McpContextRecord {
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
    automaticReentrySourceKind?:
        "goal" | "goal-resume" | "goal-retry" | "task-resume" | "wait";
    externalBindings?: McpContextExternalBinding[];
    maskedInstances?: string[];
    remoteInstanceHandles?: McpContextRemoteInstanceHandle[];
}

export interface McpContextAutomaticReentryState {
    attempted: boolean;
    claimId?: string;
    epoch: number;
    executionActive: boolean;
    executionEpoch: number;
    executionLastActivityAt?: string;
    executionLeaseUntil?: string;
    mode: McpContextAutomaticReentryMode;
    pending: boolean;
    reason?: string;
    sourceId?: string;
    sourceKind?: "goal" | "goal-resume" | "goal-retry" | "task-resume" | "wait";
    suppressedAt?: string;
}

export const AUTOMATIC_REENTRY_CLAIM_TTL_MS = 2 * 60_000;
export const MCP_CONTEXT_EXECUTION_LEASE_MS = 60 * 1_000;

export interface McpContextDocument {
    contexts: McpContextStoredRecord[];
    version: 1;
}

export interface McpContextRegistryOptions {
    executionFilePath?: string;
    filePath?: string;
    idFactory?: () => string;
    maxTerminalContexts?: number;
    now?: () => number;
    ttlMs?: number;
}
