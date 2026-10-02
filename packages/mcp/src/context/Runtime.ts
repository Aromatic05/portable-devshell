import type { ContextRegistryPort } from "@portable-devshell/shared";
import type { ContextCleanupPort, ContextEnvironmentPort } from "./Port.js";

export interface ContextRuntimePort {
    readonly registry: ContextRegistryPort;
    readonly environment: ContextEnvironmentPort;
    readonly cleanup: ContextCleanupPort;
    initialize(): Promise<void>;
    reconcile(): Promise<void>;
    bindPresentation(presentation: {
        revokeContext(ctxId: string): Promise<void>;
        revokeInstance(instance: string): Promise<void>;
    }): void;
}

