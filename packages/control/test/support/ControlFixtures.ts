import type { InstanceDescriptor } from "../../../core/src/instance/Descriptor.ts.ts";
import type { WorkerInstance } from "../../../core/src/instance/runtime/index.ts.ts";

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
