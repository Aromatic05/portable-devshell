import type {
    InstanceSnapshot,
    OperationalHealth,
    OperationalOverviewActivity,
    OperationalOverviewAlert,
    OperationalOverviewSystem,
    OperationalOverviewTodo,
    ToolCallRecord,
} from "@portable-devshell/shared";

const errorSummaryLimit = 240;

export function createSnapshotAlerts(
    instanceName: InstanceSnapshot["name"],
    snapshot: InstanceSnapshot,
): OperationalOverviewAlert[] {
    if (isCriticalSnapshot(snapshot)) {
        return [
            {
                detail:
                    summarize(snapshot.lastErrorMessage) ??
                    describeSnapshot(snapshot),
                id: `instance.failed:${instanceName}`,
                instance: instanceName,
                kind: "instance.failed",
                severity: "critical",
                title: "Instance failed",
            },
        ];
    }
    if (isAttentionSnapshot(snapshot)) {
        return [
            {
                detail:
                    summarize(snapshot.lastErrorMessage) ??
                    describeSnapshot(snapshot),
                id: `instance.attention:${instanceName}`,
                instance: instanceName,
                kind: "instance.attention",
                severity: "attention",
                title: "Instance needs attention",
            },
        ];
    }
    return [];
}

export function createTodoAlerts(
    instance: OperationalOverviewTodo["instance"],
    todos: readonly OperationalOverviewTodo[],
): OperationalOverviewAlert[] {
    return todos.flatMap((todo) => {
        if (todo.status !== "blocked" && todo.status !== "failed") {
            return [];
        }
        return [
            {
                detail:
                    todo.currentItem ??
                    `${todo.completed}/${todo.total} items completed.`,
                id: `todo.${todo.status}:${instance}:${todo.taskId}`,
                instance,
                kind:
                    todo.status === "failed"
                        ? ("todo.failed" as const)
                        : ("todo.blocked" as const),
                severity:
                    todo.status === "failed"
                        ? ("critical" as const)
                        : ("attention" as const),
                title: `${todo.status === "failed" ? "Failed" : "Blocked"} task: ${todo.title}`,
            },
        ];
    });
}

export function createRecentFailureAlert(
    instance: InstanceSnapshot["name"],
    summary: { count: number; latest?: ToolCallRecord },
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
            title: "Recent tool failures",
        },
        count: summary.count,
    };
}

export function toOperationalActivity(
    record: ToolCallRecord,
): OperationalOverviewActivity {
    const errorSummary = summarize(record.error);
    return {
        callId: record.callId,
        ...(record.completedAt === undefined
            ? {}
            : { completedAt: record.completedAt }),
        ...(errorSummary === undefined ? {} : { errorSummary }),
        instance: record.instance,
        source: record.source,
        startedAt: record.startedAt,
        status: record.status,
        toolName: record.toolName,
    };
}

export function selectOperationalActivity(
    records: readonly ToolCallRecord[],
    limit: number,
): OperationalOverviewActivity[] {
    return [...records]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, Math.max(0, limit))
        .map(toOperationalActivity);
}

export function createCollectionFailure(
    instance: OperationalOverviewAlert["instance"],
    subject: string,
    error: unknown,
): OperationalOverviewAlert {
    return {
        detail:
            summarize(error instanceof Error ? error.message : String(error)) ??
            "Unknown collection failure.",
        id: `overview.partial:${instance ?? "control"}:${subject}`,
        ...(instance === undefined ? {} : { instance }),
        kind: "overview.partial",
        severity: "attention",
        title: `Could not read ${subject}`,
    };
}

export function isCriticalSnapshot(snapshot: InstanceSnapshot): boolean {
    return (
        snapshot.status === "failed" ||
        snapshot.connectionState === "failed" ||
        snapshot.daemonState === "failed"
    );
}

export function isAttentionSnapshot(snapshot: InstanceSnapshot): boolean {
    return (
        !snapshot.ready &&
        !isCriticalSnapshot(snapshot) &&
        !(
            snapshot.status === "stopped" &&
            snapshot.connectionState === "disconnected" &&
            snapshot.daemonState === "stopped"
        )
    );
}

export function sortOperationalAlerts(
    alerts: OperationalOverviewAlert[],
): void {
    alerts.sort((left, right) => {
        const severity =
            severityRank(right.severity) - severityRank(left.severity);
        return severity === 0 ? left.id.localeCompare(right.id) : severity;
    });
}

export function readOperationalHealth(
    alerts: readonly OperationalOverviewAlert[],
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

const diskAttentionPercent = 85;

const diskCriticalPercent = 95;

const memoryAttentionPercent = 90;

const memoryCriticalPercent = 97;

export interface OperationalOverviewCpuTimes {
    idle: number;
    total: number;
}

export interface OperationalOverviewDiskUsage {
    availableBytes: number;
    totalBytes: number;
}

export interface OperationalOverviewSystemCollection {
    alerts: OperationalOverviewAlert[];
    system: OperationalOverviewSystem;
}

export interface OperationalOverviewSystemSample {
    cpu: OperationalOverviewCpuTimes;
    cpuCount: number;
    disk?: OperationalOverviewDiskUsage;
    diskPath: string;
    freeMemoryBytes: number;
    load1m: number;
    previousCpu?: OperationalOverviewCpuTimes;
    totalMemoryBytes: number;
}

export function createOperationalOverviewSystemCollection(
    sample: OperationalOverviewSystemSample,
): OperationalOverviewSystemCollection {
    const cpu = normalizeCpuTimes(sample.cpu);
    const previousCpu =
        sample.previousCpu === undefined
            ? undefined
            : normalizeCpuTimes(sample.previousCpu);
    const cpuPercent = calculateCpuPercent(previousCpu, cpu);
    const memoryTotalBytes = normalizeBytes(sample.totalMemoryBytes);
    const memoryAvailableBytes = Math.min(
        memoryTotalBytes,
        normalizeBytes(sample.freeMemoryBytes),
    );
    const memoryPercent = usedPercent(
        memoryTotalBytes - memoryAvailableBytes,
        memoryTotalBytes,
    );
    const system: OperationalOverviewSystem = {
        cpuCount: Math.max(1, Math.floor(sample.cpuCount)),
        ...(cpuPercent === undefined ? {} : { cpuPercent }),
        diskPath: sample.diskPath,
        load1m: normalizeLoad(sample.load1m),
        memoryAvailableBytes,
        memoryPercent,
        memoryTotalBytes,
    };
    const alerts: OperationalOverviewAlert[] = [];

    if (sample.disk !== undefined) {
        const diskTotalBytes = normalizeBytes(sample.disk.totalBytes);
        const diskAvailableBytes = Math.min(
            diskTotalBytes,
            normalizeBytes(sample.disk.availableBytes),
        );
        const diskPercent = usedPercent(
            diskTotalBytes - diskAvailableBytes,
            diskTotalBytes,
        );
        Object.assign(system, {
            diskAvailableBytes,
            diskPercent,
            diskTotalBytes,
        });
        const diskAlert = resourceAlert({
            attentionPercent: diskAttentionPercent,
            criticalPercent: diskCriticalPercent,
            detail: `${sample.diskPath} has ${diskAvailableBytes} bytes available.`,
            id: "controller.diskPressure",
            kind: "controller.diskPressure",
            percent: diskPercent,
            title: "Controller disk pressure",
        });
        if (diskAlert !== undefined) alerts.push(diskAlert);
    }

    const memoryAlert = resourceAlert({
        attentionPercent: memoryAttentionPercent,
        criticalPercent: memoryCriticalPercent,
        detail: `${memoryAvailableBytes} of ${memoryTotalBytes} bytes available.`,
        id: "controller.memoryPressure",
        kind: "controller.memoryPressure",
        percent: memoryPercent,
        title: "Controller memory pressure",
    });
    if (memoryAlert !== undefined) alerts.push(memoryAlert);

    return { alerts, system };
}

function calculateCpuPercent(
    previous: OperationalOverviewCpuTimes | undefined,
    current: OperationalOverviewCpuTimes,
): number | undefined {
    const total =
        previous === undefined ? current.total : current.total - previous.total;
    const idle =
        previous === undefined ? current.idle : current.idle - previous.idle;
    if (total <= 0 || idle < 0 || idle > total) return undefined;
    return roundPercent(((total - idle) * 100) / total);
}

function normalizeCpuTimes(
    value: OperationalOverviewCpuTimes,
): OperationalOverviewCpuTimes {
    return {
        idle: normalizeBytes(value.idle),
        total: normalizeBytes(value.total),
    };
}

function normalizeBytes(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeLoad(value: number): number | undefined {
    return Number.isFinite(value) && value >= 0
        ? Math.round(value * 100) / 100
        : undefined;
}

function usedPercent(used: number, total: number): number {
    return total <= 0 ? 0 : roundPercent((used * 100) / total);
}

function roundPercent(value: number): number {
    return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function resourceAlert(input: {
    attentionPercent: number;
    criticalPercent: number;
    detail: string;
    id: string;
    kind: "controller.diskPressure" | "controller.memoryPressure";
    percent: number;
    title: string;
}): OperationalOverviewAlert | undefined {
    if (input.percent < input.attentionPercent) return undefined;
    return {
        detail: `${input.percent}% used; ${input.detail}`,
        id: input.id,
        kind: input.kind,
        severity:
            input.percent >= input.criticalPercent ? "critical" : "attention",
        title: input.title,
    };
}
