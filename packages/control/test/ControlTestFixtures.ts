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
        async list() { return []; },
        async manage() { return undefined; },
        async read() { return undefined; },
        async recordReentry() {},
        async stopAll() { return []; },
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
        async cancelAll() {},
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
    const workerWithDefaults = worker as WorkerInstance & {
        listPendingApprovals?: (ctxId?: string) => ReturnType<WorkerInstance["listApprovals"]>;
        readToolCallFailureSummary?: (sinceMs: number, untilMs: number) => Promise<{ count: number }>;
    };
    workerWithDefaults.listPendingApprovals ??= async (ctxId) =>
        (await workerWithDefaults.listApprovals()).filter((approval) =>
            approval.status === "pending" && (ctxId === undefined || approval.ctxId === ctxId)
        );
    workerWithDefaults.readToolCallFailureSummary ??= async () => ({ count: 0 });
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
        worker: workerWithDefaults,
        ...overrides
    };
}
