import type {
    OperationalOverviewActivity,
    OperationalOverviewAlert,
    OperationalOverviewInstance,
    OperationalOverviewTodo
} from "@portable-devshell/shared";

import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import type { TuiExpandableBoxStatus } from "../../state/TuiUiState.js";
import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import {
    compactSummary,
    formatField,
    makeBox,
    shortenPath
} from "./TuiPageBoxSupport.js";
import {
    selectTuiOverviewPresentation,
    type TuiOverviewPresentation
} from "./TuiOverviewPresentation.js";

export function buildOverviewPageBoxes(state: TuiAppState): BoxModel[] {
    const overview = state.operationalOverview;
    if (overview === undefined) {
        return [makeBox(state, "overview", undefined, {
            detailLines: [
                "The connected control server does not provide overview.get.",
                "Reload after upgrading or reconnecting the control process."
            ],
            id: "overview-unavailable",
            status: "warning",
            summaryLines: ["Shared operational overview is unavailable."],
            title: "Operational Overview"
        })];
    }

    const presentation = selectTuiOverviewPresentation(overview);
    return [
        buildHealthBox(state, presentation),
        ...buildAlertBoxes(state, presentation.alerts),
        ...buildInstanceBoxes(state, presentation.instances),
        ...buildActivityBoxes(state, presentation.activity),
        ...buildTodoBoxes(state, presentation.todos)
    ];
}

function buildHealthBox(
    state: TuiAppState,
    presentation: TuiOverviewPresentation
): BoxModel {
    const overview = state.operationalOverview!;
    const counts = overview.counts;
    const system = overview.controller.system;
    return makeBox(state, "overview", undefined, {
        detailLines: [
            formatField("Generated", overview.generatedAt),
            formatField("Controller PID", String(overview.controller.pid)),
            formatField("Uptime", formatDuration(overview.controller.uptimeSeconds)),
            ...(system === undefined ? [] : [
                formatField("CPU", `${formatPercent(system.cpuPercent)} · ${system.cpuCount} cores`),
                formatField("Load 1m", system.load1m === undefined ? "—" : String(system.load1m)),
                formatField("Memory", `${formatPercent(system.memoryPercent)} · ${formatBytes(system.memoryAvailableBytes)} available`),
                ...(system.diskPercent === undefined
                    ? []
                    : [formatField("Disk", `${formatPercent(system.diskPercent)} · ${formatBytes(system.diskAvailableBytes ?? 0)} available`)]),
                ...(system.diskPath === undefined
                    ? []
                    : [formatField("Disk path", shortenPath(system.diskPath))])
            ]),
            formatField("Instances", `${counts.instancesReady}/${counts.instancesTotal} ready`),
            formatField("Critical", String(counts.instancesCritical)),
            formatField("Attention", String(counts.instancesAttention)),
            formatField("Approvals", String(counts.pendingApprovals)),
            formatField("Failures 24h", String(counts.failedCalls24h)),
            formatField("Active todos", String(counts.activeTodos)),
            formatField("Hidden alerts", String(presentation.omitted.alerts)),
            formatField("Hidden instances", String(presentation.omitted.instances)),
            formatField("Hidden activity", String(presentation.omitted.activity)),
            formatField("Hidden todos", String(presentation.omitted.todos))
        ],
        id: "overview-health",
        severity: overview.health === "critical" ? "danger" : overview.health === "attention" ? "warning" : "success",
        status: overview.health === "critical" ? "failed" : overview.health === "attention" ? "warning" : "ready",
        summaryLines: [
            compactSummary(
                ["health", overview.health],
                ["ready", `${counts.instancesReady}/${counts.instancesTotal}`],
                ["approvals", String(counts.pendingApprovals)]
            ),
            compactSummary(
                ["critical", String(counts.instancesCritical)],
                ["failures24h", String(counts.failedCalls24h)],
                ["cpu", formatPercent(system?.cpuPercent)],
                ["mem", formatPercent(system?.memoryPercent)],
                ["disk", formatPercent(system?.diskPercent)]
            )
        ],
        title: "Operational Health"
    });
}

function buildAlertBoxes(
    state: TuiAppState,
    alerts: readonly OperationalOverviewAlert[]
): BoxModel[] {
    if (alerts.length === 0) {
        return [makeBox(state, "overview", undefined, {
            detailLines: ["No derived operational alerts are active."],
            id: "overview-alerts-clear",
            status: "ready",
            summaryLines: ["No active alerts."],
            title: "Alerts"
        })];
    }
    return alerts.map((alert) => makeBox(state, "overview", undefined, {
        detailLines: [
            formatField("Severity", alert.severity),
            formatField("Kind", alert.kind),
            ...(alert.instance === undefined ? [] : [formatField("Instance", alert.instance)]),
            formatField("Detail", alert.detail),
            formatField("Alert ID", alert.id)
        ],
        id: `overview-alert:${alert.id}`,
        searchText: `${alert.title} ${alert.detail} ${alert.instance ?? ""}`,
        severity: alert.severity === "critical" ? "danger" : "warning",
        status: alert.severity === "critical" ? "failed" : "warning",
        summaryLines: [
            compactSummary(
                ["severity", alert.severity],
                ["kind", alert.kind],
                ["instance", alert.instance ?? "control"]
            ),
            alert.detail
        ],
        title: `Alert · ${alert.title}`
    }));
}

function buildInstanceBoxes(
    state: TuiAppState,
    instances: readonly OperationalOverviewInstance[]
): BoxModel[] {
    if (instances.length === 0) {
        return [makeBox(state, "overview", undefined, {
            detailLines: ["No instances are currently registered."],
            id: "overview-instances-empty",
            status: "normal",
            summaryLines: ["No instances."],
            title: "Instances"
        })];
    }
    return instances.map((instance) => buildInstanceBox(state, instance));
}

function buildInstanceBox(
    state: TuiAppState,
    instance: OperationalOverviewInstance
): BoxModel {
    const snapshot = instance.snapshot;
    return makeBox(state, "overview", undefined, {
        detailLines: [
            formatField("Provider", instance.provider),
            formatField("Workspace", instance.workspace === undefined ? "—" : shortenPath(instance.workspace)),
            formatField("Runtime", snapshot.status),
            formatField("Connection", snapshot.connectionState),
            formatField("Daemon", snapshot.daemonState),
            formatField("Ready", snapshot.ready ? "yes" : "no"),
            formatField("MCP", instance.mcpEnabled ? "enabled" : "disabled"),
            formatField("Approvals", String(instance.pendingApprovals)),
            ...(snapshot.lastErrorMessage === undefined
                ? []
                : [formatField("Last error", snapshot.lastErrorMessage)])
        ],
        id: `overview-instance:${instance.name}`,
        searchText: `${instance.name} ${instance.provider} ${instance.workspace ?? ""}`,
        status: instanceStatus(instance),
        summaryLines: [
            compactSummary(
                ["provider", instance.provider],
                ["status", snapshot.status],
                ["ready", snapshot.ready ? "yes" : "no"]
            ),
            compactSummary(
                ["connection", snapshot.connectionState],
                ["approvals", String(instance.pendingApprovals)],
                ["mcp", instance.mcpEnabled ? "on" : "off"]
            )
        ],
        title: `Instance · ${instance.name}`
    });
}

function buildActivityBox(
    state: TuiAppState,
    activity: OperationalOverviewActivity
): BoxModel {
    return makeBox(state, "overview", undefined, {
        detailLines: [
            formatField("Instance", activity.instance),
            formatField("Tool", activity.toolName),
            formatField("Source", activity.source),
            formatField("Status", activity.status),
            formatField("Started", activity.startedAt),
            ...(activity.completedAt === undefined
                ? []
                : [formatField("Completed", activity.completedAt)]),
            ...(activity.errorSummary === undefined
                ? []
                : [formatField("Error", activity.errorSummary)]),
            formatField("Call ID", activity.callId)
        ],
        id: `overview-activity:${activity.callId}`,
        searchText: `${activity.instance} ${activity.toolName} ${activity.status} ${activity.errorSummary ?? ""}`,
        status: activityStatus(activity),
        summaryLines: [
            compactSummary(
                ["instance", activity.instance],
                ["tool", activity.toolName],
                ["status", activity.status]
            ),
            activity.errorSummary ?? `${activity.source} · ${activity.startedAt}`
        ],
        title: `Activity · ${activity.toolName}`
    });
}

function buildActivityBoxes(
    state: TuiAppState,
    activity: readonly OperationalOverviewActivity[]
): BoxModel[] {
    if (activity.length === 0) {
        return [makeBox(state, "overview", undefined, {
            detailLines: ["No recent tool activity is available."],
            id: "overview-activity-empty",
            status: "normal",
            summaryLines: ["No recent activity."],
            title: "Activity"
        })];
    }
    return activity.map((record) => buildActivityBox(state, record));
}

function buildTodoBox(
    state: TuiAppState,
    todo: OperationalOverviewTodo
): BoxModel {
    return makeBox(state, "overview", undefined, {
        detailLines: [
            formatField("Instance", todo.instance),
            formatField("Status", todo.status),
            formatField("Progress", `${todo.completed}/${todo.total}`),
            formatField("Revision", String(todo.revision)),
            ...(todo.currentItem === undefined
                ? []
                : [formatField("Current", todo.currentItem)]),
            formatField("Task ID", todo.taskId)
        ],
        id: `overview-todo:${todo.instance}:${todo.taskId}`,
        searchText: `${todo.instance} ${todo.title} ${todo.status} ${todo.currentItem ?? ""}`,
        status: todoStatus(todo),
        summaryLines: [
            compactSummary(
                ["instance", todo.instance],
                ["status", todo.status],
                ["progress", `${todo.completed}/${todo.total}`]
            ),
            todo.currentItem ?? "No current item."
        ],
        title: `Todo · ${todo.title}`
    });
}

function buildTodoBoxes(
    state: TuiAppState,
    todos: readonly OperationalOverviewTodo[]
): BoxModel[] {
    if (todos.length === 0) {
        return [makeBox(state, "overview", undefined, {
            detailLines: [
                "No failed, blocked, or in-progress tasks require attention.",
                "Use the Todo page for the complete per-instance task list."
            ],
            id: "overview-todos-clear",
            status: "ready",
            summaryLines: ["No actionable todos."],
            title: "Todos · read-only"
        })];
    }
    return todos.map((todo) => buildTodoBox(state, todo));
}

function instanceStatus(instance: OperationalOverviewInstance): TuiExpandableBoxStatus {
    const snapshot = instance.snapshot;
    if (snapshot.status === "failed" || snapshot.connectionState === "failed" || snapshot.daemonState === "failed") {
        return "failed";
    }
    if (snapshot.ready) {
        return "ready";
    }
    if (snapshot.daemonState === "running" || snapshot.status === "running") {
        return "running";
    }
    return "warning";
}

function activityStatus(activity: OperationalOverviewActivity): TuiExpandableBoxStatus {
    switch (activity.status) {
        case "completed":
            return "ready";
        case "running":
            return "running";
        case "queued":
        case "pendingApproval":
            return "pending";
        case "cancelled":
            return "warning";
        case "failed":
        case "denied":
        case "expired":
        case "queueTimeout":
            return "failed";
    }
}

function todoStatus(todo: OperationalOverviewTodo): TuiExpandableBoxStatus {
    switch (todo.status) {
        case "none":
            return "normal";
        case "completed":
            return "ready";
        case "in_progress":
            return "running";
        case "pending":
            return "pending";
        case "cancelled":
            return "disabled";
        case "blocked":
            return "warning";
        case "failed":
            return "failed";
    }
}

function formatDuration(seconds: number): string {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

function formatPercent(value: number | undefined): string {
    return value === undefined ? "—" : `${value}%`;
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unit]}`;
}
