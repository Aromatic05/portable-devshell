import type {
    McpContextAutomaticReentryMode,
    McpContextAutomaticReentrySourceKind,
    McpContextExternalBinding,
    McpContextEnvironmentCleanup,
} from "@portable-devshell/shared";
import type {
    McpContextEnvironment,
    McpContextRecord,
} from "@portable-devshell/shared";

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

export function parseContextEnvironments(
    value: unknown,
): McpContextEnvironment[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const environments: McpContextEnvironment[] = [];
    const instances = new Set<string>();
    for (const candidate of value) {
        const environment = parseEnvironment(candidate);
        if (environment === undefined || instances.has(environment.instance))
            return undefined;
        instances.add(environment.instance);
        environments.push(environment);
    }
    return environments;
}

function parseEnvironment(value: unknown): McpContextEnvironment | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const environment = value as Partial<McpContextEnvironment>;
    if (
        typeof environment.instance !== "string" ||
        environment.instance.length === 0 ||
        (environment.workspace !== undefined &&
            typeof environment.workspace !== "string") ||
        (environment.temporaryDirectory !== undefined &&
            typeof environment.temporaryDirectory !== "string")
    )
        return undefined;
    return {
        instance: environment.instance,
        ...(environment.temporaryDirectory === undefined
            ? {}
            : { temporaryDirectory: environment.temporaryDirectory }),
        ...(environment.workspace === undefined
            ? {}
            : { workspace: environment.workspace }),
    };
}
