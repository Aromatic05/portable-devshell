import type {
    ApprovalRequest,
    InstanceEvent,
} from "@portable-devshell/shared/browser";
import type {
    OperationalOverview,
    OperationalOverviewActivity,
    OperationalOverviewAlert,
} from "../../../shared/src/dto/overview/DtoOperationalOverview.js";

import type { WebState } from "../state/WebStore.js";

export interface TodoSummary {
    completed: number;
    instance: string;
    revision: number;
    status: string;
    title: string;
    total: number;
}

export function pendingApprovals(state: WebState): number {
    return (
        toolApprovals(state).length +
        state.oauthApprovals.filter((approval) => approval.status === "pending").length
    );
}

export function toolApprovals(state: WebState): ApprovalRequest[] {
    return Object.values(state.approvals).flatMap((approvals) =>
        approvals.filter((approval) => approval.status === "pending"),
    );
}

export function todoSummaries(state: WebState): TodoSummary[] {
    return Object.entries(state.todos).flatMap(([instance, todo]) => {
        const tasks = todo.tasks ?? (todo.title === undefined ? [] : [{
            completed: todo.summary.completed,
            revision: todo.revision,
            status: todo.summary.currentItemId === undefined ? "none" : "in_progress",
            taskId: todo.taskId ?? todo.title,
            title: todo.title,
            total: todo.summary.total,
            updatedAt: "",
        }]);
        return tasks.map((task) => ({
            completed: task.completed,
            instance,
            revision: task.revision,
            status: task.status,
            title: task.title,
            total: task.total,
        }));
    });
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

export function overviewActivity(
    overview: OperationalOverview,
): OperationalOverviewActivity[] {
    return overview.activity.slice(0, 6);
}

export function recentActivity(state: WebState, query = "", type = "all"): InstanceEvent[] {
    const needle = query.trim().toLowerCase();
    return [...state.activity]
        .reverse()
        .filter((event) => type === "all" || event.type === type)
        .filter((event) => needle.length === 0 || `${event.instanceName} ${event.type}`.toLowerCase().includes(needle))
        .slice(0, 100);
}
