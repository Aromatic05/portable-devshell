import type { ApprovalRequest, InstanceEvent } from "@portable-devshell/shared/browser";

import type { WebState } from "../state/WebStore.js";

export interface Alert {
    id: string;
    message: string;
    severity: "attention" | "critical";
}

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

export function alerts(state: WebState): Alert[] {
    const result: Alert[] = [];
    if (state.connection === "offline") {
        result.push({ id: "connection", message: "Control connection is offline.", severity: "critical" });
    }
    for (const entry of state.instances) {
        const snapshot = entry.snapshot;
        if (["failed", "stale"].includes(snapshot.status) || ["failed", "disconnected"].includes(snapshot.connectionState)) {
            result.push({
                id: `instance:${entry.name}`,
                message: `${entry.name}: ${snapshot.lastErrorMessage ?? `${snapshot.status} / ${snapshot.connectionState}`}`,
                severity: snapshot.status === "failed" || snapshot.connectionState === "failed" ? "critical" : "attention",
            });
        }
    }
    const pending = pendingApprovals(state);
    if (pending > 0) result.push({ id: "approvals", message: `${pending} approval${pending === 1 ? "" : "s"} pending.`, severity: "attention" });
    for (const event of state.activity.filter((item) => item.type === "toolCall.failed")) {
        result.push({ id: `activity:${event.instanceName}:${event.seq}`, message: `${event.instanceName}: failed activity.`, severity: "critical" });
    }
    return result;
}

export function recentActivity(state: WebState, query = "", type = "all"): InstanceEvent[] {
    const needle = query.trim().toLowerCase();
    return [...state.activity]
        .reverse()
        .filter((event) => type === "all" || event.type === type)
        .filter((event) => needle.length === 0 || `${event.instanceName} ${event.type}`.toLowerCase().includes(needle))
        .slice(0, 100);
}
