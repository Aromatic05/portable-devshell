import type {
    GoalSnapshot,
    JsonValue,
    TodoTaskSummary,
    WaitRecord,
} from "@portable-devshell/shared";

import {
    isMcpGoalGateway,
    type McpWorkspaceActionGateway,
} from "../../endpoint/Port.js";
import type {
    WorkspaceBackgroundItem,
    WorkspaceResolvedAction,
    WorkspaceWorkItem,
} from "../Contract.js";
import { contributeGoal } from "./Goal.js";
import { contributeTodo } from "./Todo.js";
import { contributeWaits } from "./Wait.js";

export interface WorkspaceTaskContribution {
    actions: WorkspaceResolvedAction[];
    background: WorkspaceBackgroundItem[];
    model: {
        background: WaitRecord[];
        goal?: GoalSnapshot;
        tasks: TodoTaskSummary[];
        waits: WaitRecord[];
    };
    primaryOrder: ReturnType<typeof contributeWaits>["primaryOrder"];
    work: WorkspaceWorkItem[];
}

export async function readTaskContribution(
    gateway: McpWorkspaceActionGateway,
    instance: string,
    ctxId: string,
    reentry?: JsonValue,
): Promise<WorkspaceTaskContribution> {
    const goalGateway = isMcpGoalGateway(gateway) ? gateway : undefined;
    const [todoValue, waits, goal] = await Promise.all([
        gateway.readTodo(instance),
        gateway.listWaits(instance),
        goalGateway?.readGoal(instance, ctxId),
    ]);
    const todo = record(todoValue);
    const tasks = Array.isArray(todo?.tasks)
        ? (todo.tasks as unknown as TodoTaskSummary[])
        : [];
    const capability = gateway;
    const wait = contributeWaits(waits, ctxId, instance, {
        answer: capability.resolveWait !== undefined,
        interrupt:
            capability.cancelWait !== undefined &&
            capability.reattachWait !== undefined &&
            capability.resolveWait !== undefined,
        dismissRecovery:
            capability.claimWaitRecovery !== undefined &&
            capability.completeWaitRecovery !== undefined &&
            capability.disableWaitRecovery !== undefined &&
            capability.dismissWaitRecovery !== undefined &&
            capability.markWaitRecoveryAttempted !== undefined &&
            capability.rejectWaitRecovery !== undefined &&
            capability.releaseWaitRecovery !== undefined,
    });
    const todoProjection = contributeTodo(
        tasks,
        ctxId,
        instance,
        gateway.controlTodo !== undefined,
    );
    const state = record(reentry);
    const goalProjection = contributeGoal(
        goal,
        ctxId,
        instance,
        typeof state?.epoch === "number" ? state.epoch : 0,
    );
    return {
        actions: [
            ...wait.actions,
            ...todoProjection.actions,
            ...goalProjection.actions,
        ],
        background: wait.background,
        model: {
            background: wait.modelBackground,
            ...(goal === undefined ? {} : { goal }),
            tasks: todoProjection.modelTasks,
            waits: wait.modelWaits,
        },
        primaryOrder: wait.primaryOrder,
        work: [
            ...(goalProjection.item === undefined ? [] : [goalProjection.item]),
            ...todoProjection.items,
        ],
    };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
