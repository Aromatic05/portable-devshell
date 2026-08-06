import {
    projectTodoTaskSummaries,
    type ApprovalRequest,
    type OperationalOverview,
    type OperationalOverviewActivity,
    type OperationalOverviewAlert,
} from "@portable-devshell/shared/browser";

import type { WebState } from "../state/WebStore.js";

export interface TodoSummary {
    completed: number;
    instance: string;
    revision: number;
    status: string;
    taskId: string;
    title: string;
    total: number;
}

export function pendingApprovals(state: WebState): number {
    return (
        toolApprovals(state).length +
        state.readModel.oauthApprovals.filter((approval) => approval.status === "pending").length
    );
}

export function toolApprovals(state: WebState): ApprovalRequest[] {
    return Object.values(state.readModel.instanceState).map((instance) => instance.approvals).flatMap((approvals) =>
        approvals.filter((approval) => approval.status === "pending"),
    );
}

export function todoSummaries(state: WebState): TodoSummary[] {
    return Object.entries(state.readModel.instanceState).flatMap(([instance, value]) => value.todo === undefined ? [] : [[instance, value.todo] as const]).flatMap(([instance, todo]) =>
        projectTodoTaskSummaries(todo).map((task) => ({
            completed: task.completed,
            instance,
            revision: task.revision,
            status: task.status,
            taskId: task.taskId,
            title: task.title,
            total: task.total,
        })),
    );
}

export function openTodos(state: WebState): number {
    return todoSummaries(state).filter(
        (todo) => !["completed", "cancelled", "none"].includes(todo.status),
    ).length;
}

export function overviewAlerts(
    overview: OperationalOverview,
): OperationalOverviewAlert[] {
    return overview.alerts.slice(0, 8);
}

export function overviewToolCalls(
    overview: OperationalOverview,
): OperationalOverviewActivity[] {
    return overview.activity.slice(0, 6);
}

export function overviewAlertRoute(kind: OperationalOverviewAlert["kind"]): string {
    if (kind.startsWith("approval.")) return "#/approvals";
    if (kind.startsWith("todo.")) return "#/todos";
    if (kind.startsWith("activity.")) return "#/activity";
    if (kind.startsWith("instance.")) return "#/instances";
    return "#/overview";
}
