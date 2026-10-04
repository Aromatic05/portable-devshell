import type {
    InstanceDescriptor,
    WorkerInstance,
} from "@portable-devshell/core/testing";

export function createTestInstanceDescriptor(
    worker: WorkerInstance,
    overrides: Partial<Omit<InstanceDescriptor, "worker">> = {},
): InstanceDescriptor {
    const workerWithDefaults = worker as WorkerInstance & {
        readToolCallFailureSummary?: (
            sinceMs: number,
            untilMs: number,
        ) => Promise<{ count: number }>;
    };
    workerWithDefaults.readToolCallFailureSummary ??= async () => ({
        count: 0,
    });
    return {
        enabled: true,
        mcpEnabled: false,
        mcpPath: "",
        modelExtensions: [],
        name: "alpha",
        provider: "local",
        worker: workerWithDefaults,
        ...overrides,
    };
}
