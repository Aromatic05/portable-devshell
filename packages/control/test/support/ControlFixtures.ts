import { Instance, type InstanceFields, type WorkerInstance } from "@portable-devshell/core/instance";

export function createTestInstance(
    worker: WorkerInstance,
    overrides: Partial<Omit<InstanceFields, "worker">> = {},
): Instance {
    return new Instance({
        enabled: true,
        mcpEnabled: false,
        mcpPath: "",
        modelExtensions: [],
        name: "alpha",
        provider: "local",
        worker,
        ...overrides,
    });
}
