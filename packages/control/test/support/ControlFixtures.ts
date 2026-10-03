import type { WorkerInstance } from "@portable-devshell/core";
import type { TodoReadResult } from "@portable-devshell/shared";

import type {
    InstanceApprovalPort,
    InstanceDescriptor,
    InstanceGoalPort,
    InstanceTodoPort,
} from "@portable-devshell/core";

export function createTestGoalPort(): InstanceGoalPort {
    return {
        async continuation() {
            return {};
        },
        async list() {
            return [];
        },
        async manage() {
            return undefined;
        },
        async read() {
            return undefined;
        },
        async recordReentry() {},
        async stopAll() {
            return [];
        },
        async touch() {},
    };
}

export function createTestTodoPort(): InstanceTodoPort {
    const empty: TodoReadResult = {
        items: [],
        revision: 0,
        summary: { completed: 0, total: 0 },
    };
    return {
        async cancelAll() {},
        async control() {
            return empty;
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
        },
    };
}

export function createTestApprovalPort(
    overrides: Partial<InstanceApprovalPort> = {},
): InstanceApprovalPort {
    return {
        async cancel() {
            throw new Error("Approval cancellation is not configured.");
        },
        close() {},
        async decideApproval() {
            throw new Error("Approval decisions are not configured.");
        },
        async getApproval() {
            throw new Error("Approval lookup is not configured.");
        },
        async listApprovals() {
            return [];
        },
        async listPendingApprovals() {
            return [];
        },
        async retire() {},
        setPolicy() {},
        ...overrides,
    };
}

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
        approval: createTestApprovalPort(),
        approvalReview: () => ({ decision: "continue" }),
        enabled: true,
        goal: createTestGoalPort(),
        mcpEnabled: false,
        mcpPath: "",
        modelExtensions: [],
        name: "alpha",
        provider: "local",
        todo: createTestTodoPort(),
        worker: workerWithDefaults,
        ...overrides,
    };
}
