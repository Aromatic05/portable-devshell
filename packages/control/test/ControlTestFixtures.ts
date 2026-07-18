import type { WorkerInstance } from "@portable-devshell/core";
import type { TodoReadResult } from "@portable-devshell/shared";

import type {
    InstanceDescriptor,
    InstanceTodoPort
} from "../src/control/instance/InstanceDescriptor.ts";

export function createTestTodoPort(): InstanceTodoPort {
    const empty: TodoReadResult = {
        items: [],
        revision: 0,
        summary: { completed: 0, total: 0 }
    };
    return {
        currentAssociation() {
            return undefined;
        },
        async read() {
            return empty;
        },
        summary() {
            return undefined;
        },
        async write() {
            return empty;
        }
    };
}

export function createTestInstanceDescriptor(
    worker: WorkerInstance,
    overrides: Partial<Omit<InstanceDescriptor, "worker">> = {}
): InstanceDescriptor {
    return {
        enabled: true,
        mcpCapabilities: [],
        mcpEnabled: false,
        mcpGroups: [],
        mcpPath: "",
        name: "alpha",
        provider: "local",
        todo: createTestTodoPort(),
        worker,
        ...overrides
    };
}
