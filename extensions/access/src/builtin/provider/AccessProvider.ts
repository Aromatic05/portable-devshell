import type {
    ExtensionManagedProcess,
    ExtensionProcessCapability,
} from "@portable-devshell/extension";

import type { AccessEndpoint } from "../Config.js";
import type { AccessTarget } from "../Target.js";

export interface AccessProviderContext {
    readonly dataDirectory: string;
    readonly processes: ExtensionProcessCapability;
    readonly runtimeDirectory: string;
}

export interface AccessProviderOpenInput {
    readonly endpoint: AccessEndpoint;
    readonly target: AccessTarget;
}

export interface AccessProviderSession {
    readonly closed: Promise<void>;
    readonly process: ExtensionManagedProcess;
    publicUrl(): string | undefined;
    stop(): Promise<void>;
}

export interface AccessProvider {
    readonly kind: AccessEndpoint["provider"];
    open(input: AccessProviderOpenInput): Promise<AccessProviderSession>;
}

export function managedProviderSession(
    process: ExtensionManagedProcess,
    getPublicUrl: () => string | undefined,
): AccessProviderSession {
    return Object.freeze({
        closed: process.closed.then(() => undefined),
        process,
        publicUrl: getPublicUrl,
        stop: async () => {
            await process.terminate();
            await process.closed;
        },
    });
}
