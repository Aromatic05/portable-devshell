import type {
    InstanceSnapshot,
    OperationalHealth,
    OperationalOverviewActivity,
    OperationalOverviewAlert,
    OperationalOverviewTodo,
    ToolCallRecord
} from "@portable-devshell/shared";

const failureWindowMs = 24 * 60 * 60 * 1_000;
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
    if (!snapshot.ready) {
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
    calls: readonly ToolCallRecord[],
    now: Date
): { alert?: OperationalOverviewAlert; count: number } {
    const failures = calls.filter((call) => isRecentFailure(call, now));
    if (failures.length === 0) {
        return { count: 0 };
    }
    const latest = [...failures].sort(
        (left, right) => right.startedAt.localeCompare(left.startedAt)
    )[0]!;
    return {
        alert: {
            detail: `${failures.length} failed or timed-out call${failures.length === 1 ? "" : "s"} in 24h; latest: ${latest.toolName}.`,
            id: `activity.failed:${instance}`,
            instance,
            kind: "activity.failed",
            severity: "attention",
            title: "Recent tool failures"
        },
        count: failures.length
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

function isRecentFailure(record: ToolCallRecord, now: Date): boolean {
    if (record.status !== "failed" && record.status !== "queueTimeout") {
        return false;
    }
    const timestamp = Date.parse(record.completedAt ?? record.startedAt);
    return Number.isFinite(timestamp) && now.getTime() - timestamp <= failureWindowMs;
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
