import type {
    InstanceSnapshot,
    OperationalHealth,
    OperationalOverviewActivity,
    OperationalOverviewAlert,
    OperationalOverviewTodo,
    ToolCallRecord
} from "@portable-devshell/shared";

const errorSummaryLimit = 240;

export function createSnapshotAlerts(
    instanceName: InstanceSnapshot["name"],
    snapshot: InstanceSnapshot
): OperationalOverviewAlert[] {
    if (isCriticalSnapshot(snapshot)) {
        return [{
            detail: summarize(snapshot.lastErrorMessage) ?? describeSnapshot(snapshot),
            id: `instance.failed:${instanceName}`,
            instance: instanceName,
            kind: "instance.failed",
            severity: "critical",
            title: "Instance failed"
        }];
    }
    if (isAttentionSnapshot(snapshot)) {
        return [{
            detail: summarize(snapshot.lastErrorMessage) ?? describeSnapshot(snapshot),
            id: `instance.attention:${instanceName}`,
            instance: instanceName,
            kind: "instance.attention",
            severity: "attention",
            title: "Instance needs attention"
        }];
    }
    return [];
}

export function createTodoAlerts(
    instance: OperationalOverviewTodo["instance"],
    todos: readonly OperationalOverviewTodo[]
): OperationalOverviewAlert[] {
    return todos.flatMap((todo) => {
        if (todo.status !== "blocked" && todo.status !== "failed") {
            return [];
        }
        return [{
            detail: todo.currentItem ?? `${todo.completed}/${todo.total} items completed.`,
            id: `todo.${todo.status}:${instance}:${todo.taskId}`,
            instance,
            kind: todo.status === "failed" ? "todo.failed" as const : "todo.blocked" as const,
            severity: todo.status === "failed" ? "critical" as const : "attention" as const,
            title: `${todo.status === "failed" ? "Failed" : "Blocked"} task: ${todo.title}`
        }];
    });
}

export function createRecentFailureAlert(
    instance: InstanceSnapshot["name"],
    summary: { count: number; latest?: ToolCallRecord }
): { alert?: OperationalOverviewAlert; count: number } {
    if (summary.count === 0) {
        return { count: 0 };
    }
    const latest = summary.latest;
    return {
        alert: {
            detail: `${summary.count} failed or timed-out call${summary.count === 1 ? "" : "s"} in 24h${latest === undefined ? "." : `; latest: ${latest.toolName}.`}`,
            id: `activity.failed:${instance}`,
            instance,
            kind: "activity.failed",
            severity: "attention",
            title: "Recent tool failures"
        },
        count: summary.count
    };
}

export function toOperationalActivity(
    record: ToolCallRecord
): OperationalOverviewActivity {
    const errorSummary = summarize(record.error);
    return {
        callId: record.callId,
        ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
        ...(errorSummary === undefined ? {} : { errorSummary }),
        instance: record.instance,
        source: record.source,
        startedAt: record.startedAt,
        status: record.status,
        toolName: record.toolName
    };
}

export function selectOperationalActivity(
    records: readonly ToolCallRecord[],
    limit: number
): OperationalOverviewActivity[] {
    return [...records]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, Math.max(0, limit))
        .map(toOperationalActivity);
}

export function createCollectionFailure(
    instance: OperationalOverviewAlert["instance"],
    subject: string,
    error: unknown
): OperationalOverviewAlert {
    return {
        detail: summarize(error instanceof Error ? error.message : String(error)) ?? "Unknown collection failure.",
        id: `overview.partial:${instance ?? "control"}:${subject}`,
        ...(instance === undefined ? {} : { instance }),
        kind: "overview.partial",
        severity: "attention",
        title: `Could not read ${subject}`
    };
}

export function isCriticalSnapshot(snapshot: InstanceSnapshot): boolean {
    return snapshot.status === "failed" ||
        snapshot.connectionState === "failed" ||
        snapshot.daemonState === "failed";
}

export function isAttentionSnapshot(snapshot: InstanceSnapshot): boolean {
    return !snapshot.ready &&
        !isCriticalSnapshot(snapshot) &&
        !(
            snapshot.status === "stopped" &&
            snapshot.connectionState === "disconnected" &&
            snapshot.daemonState === "stopped"
        );
}

export function sortOperationalAlerts(alerts: OperationalOverviewAlert[]): void {
    alerts.sort((left, right) => {
        const severity = severityRank(right.severity) - severityRank(left.severity);
        return severity === 0 ? left.id.localeCompare(right.id) : severity;
    });
}

export function readOperationalHealth(
    alerts: readonly OperationalOverviewAlert[]
): OperationalHealth {
    if (alerts.some((alert) => alert.severity === "critical")) {
        return "critical";
    }
    return alerts.length > 0 ? "attention" : "healthy";
}

function describeSnapshot(snapshot: InstanceSnapshot): string {
    return `${snapshot.status}; ${snapshot.connectionState}; ${snapshot.daemonState}.`;
}

function summarize(value: string | undefined): string | undefined {
    const normalized = value?.replace(/\s+/gu, " ").trim();
    if (!normalized) {
        return undefined;
    }
    return normalized.length <= errorSummaryLimit
        ? normalized
        : `${normalized.slice(0, errorSummaryLimit - 1)}…`;
}

function severityRank(severity: OperationalOverviewAlert["severity"]): number {
    return severity === "critical" ? 2 : 1;
}
