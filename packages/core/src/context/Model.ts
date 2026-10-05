import type {
    ContextEnvironment,
    ContextExternalBinding,
    ContextEnvironmentCleanup,
    ContextRecord,
} from "@portable-devshell/shared";

export const defaultContextTtlMs = 24 * 60 * 60 * 1_000;
export const defaultContextTerminalHistory = 256;

export interface ContextRemoteInstanceHandle {
    handle: string;
    instance: string;
}

export interface ContextStoredRecord extends ContextRecord {
    cleanupPending?: boolean;
    externalBindings?: ContextExternalBinding[];
    maskedInstances?: string[];
    pendingEnvironmentCleanup?: ContextEnvironmentCleanup[];
    remoteInstanceHandles?: ContextRemoteInstanceHandle[];
}

export interface ContextRegistryOptions {
    filePath?: string;
    idFactory?: () => string;
    maxTerminalContexts?: number;
    now?: () => number;
    ttlMs?: number;
}

export interface ContextDocument {
    contexts: ContextStoredRecord[];
    version: 2;
}

export function parseContextEnvironments(
    value: unknown,
): ContextEnvironment[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const environments: ContextEnvironment[] = [];
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

function parseEnvironment(value: unknown): ContextEnvironment | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const environment = value as Partial<ContextEnvironment>;
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
