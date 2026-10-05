import { Instance, InstanceRegistry, type WorkerInstance } from "@portable-devshell/core/instance";
import type { ControlConfig } from "@portable-devshell/shared";

export function createTestInstance(
    config: ControlConfig["instances"][number],
    workerOverrides: Record<string, unknown> = {},
): Instance {
    const worker = {
        managementMode: "controllerManaged",
        reconfigure: async () => undefined,
        snapshot: () => ({
            daemonState: "stopped",
            effectiveSecurityMode: config.security.mode,
            ready: false,
            status: "stopped",
        }),
        stop: async () => ({
            daemonState: "stopped",
            ready: false,
            status: "stopped",
        }),
        close: async () => undefined,
        retireRuntime: async () => undefined,
        retireProviderResources: async () => undefined,
        ...workerOverrides,
    } as unknown as WorkerInstance;
    return new Instance({
        enabled: config.enabled,
        mcpContextMode: config.mcp.contextMode,
        mcpEnabled: config.mcp.enabled,
        mcpPath: config.mcp.path,
        modelExtensions: config.extensions.model,
        name: config.name,
        provider: config.provider,
        worker,
    });
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
        retireRuntimeInstance: async () => undefined,
        finalizeRuntimeInstance: async (descriptor: Instance) =>
            await descriptor.close(),
        updateApprovalPolicy: async () => undefined,
    };
}
