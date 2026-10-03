import {
    projectTodoTaskSummaries,
    type OperationalOverview,
    type OperationalOverviewActivity,
    type OperationalOverviewAlert,
    type TodoReadResult,
} from "@portable-devshell/shared";

export interface TodoSummary {
    checkpoint?: {
        blockers?: string[];
        next?: string;
        summary: string;
        updatedAt: string;
    };
    completed: number;
    currentItem?: string;
    instance: string;
    revision: number;
    status: string;
    taskId: string;
    title: string;
    total: number;
}

export function todoSummaries(
    instance: string,
    todo: TodoReadResult | undefined,
): TodoSummary[] {
    if (todo === undefined) return [];
    return projectTodoTaskSummaries(todo).map((task) => ({
        completed: task.completed,
        ...(task.checkpoint === undefined && todo.taskId !== task.taskId
            ? {}
            : { checkpoint: task.checkpoint ?? todo.checkpoint }),
        ...(task.currentItem === undefined
            ? {}
            : { currentItem: task.currentItem }),
        instance,
        revision: task.revision,
        status: task.status,
        taskId: task.taskId,
        title: task.title,
        total: task.total,
    }));
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

export function overviewAlertRoute(
    kind: OperationalOverviewAlert["kind"],
): string {
    if (kind === "approval.pending") return "#/audit";
    if (kind === "approval.oauthPending") return "#/overview";
    if (kind.startsWith("todo.")) return "#/todos";
    if (kind.startsWith("activity.")) return "#/audit";
    if (kind.startsWith("instance.")) return "#/instances";
    return "#/overview";
}
