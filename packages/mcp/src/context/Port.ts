import type { JsonValue, McpContextEnvironment, McpContextExternalBinding } from "@portable-devshell/shared";
import type { ContextRegistryPort } from "@portable-devshell/shared";

export interface PreparedEnvironmentFacts {
    projectMemoryAgentFile: string;
    projectMemoryDirectory: string;
    projectMemoryPresent?: boolean;
    temporaryDirectory: string;
    workspace: string;
}

export interface ContextEnvironmentPort {
    prepareLocal(ctxId: string, instance: string, workspace: string, options?: {
        external?: { bindings: readonly McpContextExternalBinding[]; principal: string };
        beforeCommit?: (prepared: PreparedEnvironmentFacts) => Promise<void>;
        signal?: AbortSignal;
    }): Promise<PreparedEnvironmentFacts>;
    attachRemote(ctxId: string, handle: string, workspace?: string, signal?: AbortSignal): Promise<JsonValue>;
    maskRemote(ctxId: string, handle: string): Promise<{ instance: string; masked: true }>;
    ensurePrepared(ctxId: string, instance: string, workspace?: string): Promise<McpContextEnvironment>;
    rollbackUndisclosed(ctxId: string, instance: string, workspace?: string): Promise<void>;
}

export interface ContextCleanupPort {
    reconcile(ctxId?: string): Promise<void>;
    reconcileInstance(instance: string, resources: ContextInstanceCleanupPort): Promise<void>;
}

export interface ContextInstanceCleanupPort {
    releaseAlerts(workspace: string): Promise<void>;
    releaseInstanceReference(ctxId: string): Promise<void>;
}

export type { ContextRegistryPort };
