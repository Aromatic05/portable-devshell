import { Instance } from "@portable-devshell/core";
import type { ControlConfig } from "@portable-devshell/shared";

import { InstanceRegistry } from "../../src/instance/Registry.ts";

export interface TestInstanceRuntimeOverrides {
    close?: () => Promise<void>;
    managementMode?: "controllerManaged" | "selfManaged";
    releaseAlerts?: (workspace: string) => Promise<void>;
    releaseReference?: (reference: string) => Promise<void>;
    retireProviderResources?: () => Promise<void>;
    retireRuntime?: () => Promise<void>;
    snapshot?: () => Record<string, unknown>;
    start?: () => Promise<Record<string, unknown> | void>;
    stop?: () => Promise<Record<string, unknown> | void>;
}

export function createTestInstance(
    config: ControlConfig["instances"][number],
    overrides: TestInstanceRuntimeOverrides = {},
): Instance {
    let owned = false;
    let ready = false;
    const snapshot = () => {
        const current = overrides.snapshot?.();
        if (current !== undefined) return current;
        return {
            connectionState: ready ? "connected" : "disconnected",
            daemonState: ready ? "running" : "stopped",
            effectiveSecurityMode: config.security.mode,
            lastSeq: 0,
            name: config.name,
            ready,
            status: ready ? "running" : "stopped",
        };
    };
    const lifecycle = {
        async start() {
            const result = await overrides.start?.();
            ready = true;
            return (result ?? snapshot()) as never;
        },
        async stop() {
            const result = await overrides.stop?.();
            ready = false;
            return (result ?? snapshot()) as never;
        },
    };
    const worker = {
        execution: {
            artifact: {},
            environment: {
                async prepareExtensionResource() {
                    throw new Error("Unused test environment capability.");
                },
                async prepareWorkspace(workspace: string) {
                    return {
                        projectMemoryAgentFile: `${workspace}/AGENTS.md`,
                        projectMemoryDirectory: workspace,
                        projectMemoryPresent: false,
                        temporaryDirectory: `${workspace}/.tmp`,
                        workspace,
                    };
                },
                async readAlerts() {
                    return {};
                },
                async releaseAlerts(workspace: string) {
                    await overrides.releaseAlerts?.(workspace);
                },
                async touchAlerts() {
                    return {};
                },
                async touchTemporaryDirectory() {},
            },
            terminal: {},
            tunnel: {},
        },
        provision: {
            async retire(skipRuntimeRetirement = false) {
                const failures: unknown[] = [];
                if (!skipRuntimeRetirement)
                    await overrides.retireRuntime?.().catch((error) => failures.push(error));
                await overrides.retireProviderResources?.().catch((error) => failures.push(error));
                if (failures.length > 0)
                    throw new AggregateError(failures, "Worker resource cleanup failed.");
            },
        },
        supervision: {
            async close() {
                await overrides.close?.();
            },
            connection: {},
            endpoint: {},
            handshake: undefined,
            lifecycle,
            managementMode: overrides.managementMode ?? "controllerManaged",
            ownership: {
                clearOwned() {
                    owned = false;
                },
                get owned() {
                    return owned;
                },
                async releaseReference(reference: string) {
                    await overrides.releaseReference?.(reference);
                },
                markOwned() {
                    owned = true;
                },
            },
            recovery: {},
            snapshot: () => snapshot() as never,
            state: {},
        },
    };
    return new Instance({
        config: {
            enabled: config.enabled,
            mcpContextMode: config.mcp.contextMode,
            mcpEnabled: config.mcp.enabled,
            mcpPath: config.mcp.path,
            modelExtensions: [...config.extensions.model],
            name: config.name,
            provider: config.provider,
        },
        eventLog: {
            async flush() {},
            port: {},
        },
        state: {
            approval: { setPolicy() {} },
            async close() {},
            async prepareRetirement() {},
            async retire() {},
        },
        subscriptions: {
            close() {},
            unsubscribeConnection() {},
        },
        worker,
    } as never);
}

export function buildTestInstanceRegistry(
    config: ControlConfig,
): InstanceRegistry {
    return new InstanceRegistry(
        config.instances
            .filter((instance) => instance.enabled)
            .map((instance) => createTestInstance(instance)),
    );
}

export function testRuntimeHooks() {
    return {
        createRuntimeInstance: (config: ControlConfig["instances"][number]) =>
            createTestInstance(config),
        finalizeRuntimeInstance: async (descriptor: Instance) =>
            await descriptor.close(),
    };
}
