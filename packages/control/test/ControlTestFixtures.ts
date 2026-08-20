import type { WorkerInstance } from "@portable-devshell/core";
import type { TodoReadResult } from "@portable-devshell/shared";

import type {
    InstanceDescriptor,
    InstanceGoalPort,
    InstanceTodoPort
} from "../src/control/instance/InstanceDescriptor.ts";

export function createTestGoalPort(): InstanceGoalPort {
    return {
        async continuation() { return {}; },
        async manage() { return undefined; },
        async read() { return undefined; },
        async touch() {},
    };
}

export function createTestTodoPort(): InstanceTodoPort {
    const empty: TodoReadResult = {
        items: [],
        revision: 0,
        summary: { completed: 0, total: 0 }
    };
    return {
        async control() {
            return empty;
        },
        currentAssociation() {
            return undefined;
        },
        async delete() {
            return undefined;
        },
        async read() {
            return empty;
        },
        summaries() {
            return [];
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
        goal: createTestGoalPort(),
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
