import type {
    OperationalOverview,
    OperationalOverviewActivity,
    OperationalOverviewInstance,
} from "@portable-devshell/shared";

import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { currentTuiRouteScrollKey } from "../../state/route/TuiRouteState.js";
import type {
    TuiOverviewActivityRowModel,
    TuiOverviewInstanceRowModel,
    TuiOverviewMeterModel,
    TuiOverviewPresentation,
    TuiOverviewTone,
} from "./TuiOverviewModel.js";
import {
    formatOverviewBytes,
    formatOverviewDuration,
    formatOverviewPercent,
} from "./TuiOverviewFormatting.js";

export interface TuiOverviewInstanceViewport {
    readonly offset: number;
    readonly rows: readonly TuiOverviewInstanceRowModel[];
    readonly visibleRowCount: number;
}

const EMPTY_COUNTS: TuiOverviewPresentation["counts"] = {
    activeTodos: 0,
    failedCalls24h: 0,
    instancesAttention: 0,
    instancesCritical: 0,
    instancesReady: 0,
    instancesTotal: 0,
    pendingApprovals: 0,
};

export function selectTuiOverviewPresentation(
    state: TuiAppState,
): TuiOverviewPresentation {
    const overview = state.operationalOverview;
    const query = (state.ui.searchQueries.overview ?? "").trim().toLowerCase();
    if (overview === undefined) {
        return {
            activity: [],
            alerts: [],
            available: false,
            controller: {
                summary: "Control server has not provided operational metrics.",
                uptime: "—",
            },
            counts: EMPTY_COUNTS,
            health: "unavailable",
            instances: [],
            meters: [],
            query,
        };
    }

    const activeTodoCountByInstance = new Map<string, number>();
    for (const todo of overview.todos) {
        if (todo.status === "completed" || todo.status === "cancelled")
            continue;
        activeTodoCountByInstance.set(
            todo.instance,
            (activeTodoCountByInstance.get(todo.instance) ?? 0) + 1,
        );
    }

    const instances = overview.instances
        .map((instance) =>
            toInstanceRow(
                instance,
                activeTodoCountByInstance.get(instance.name) ?? 0,
                state.ui.mainFocusId === `overview-instance:${instance.name}`,
            ),
        )
        .filter(
            (row) =>
                query.length === 0 || instanceSearchText(row).includes(query),
        )
        .sort((left, right) => {
            const rank = toneRank(left.tone) - toneRank(right.tone);
            return rank === 0 ? left.name.localeCompare(right.name) : rank;
        });

    return {
        activity: [...overview.activity]
            .sort((left, right) =>
                right.startedAt.localeCompare(left.startedAt),
            )
            .map(toActivityRow),
        alerts: [...overview.alerts]
            .sort((left, right) => {
                const severity =
                    left.severity === right.severity
                        ? 0
                        : left.severity === "critical"
                          ? -1
                          : 1;
                return severity === 0
                    ? left.id.localeCompare(right.id)
                    : severity;
            })
            .map((alert) => ({
                detail: alert.detail,
                id: alert.id,
                instance: alert.instance,
                title: alert.title,
                tone: alert.severity === "critical" ? "danger" : "warning",
            })),
        available: true,
        controller: {
            pid: overview.controller.pid,
            summary: controllerSummary(overview),
            uptime: formatOverviewDuration(overview.controller.uptimeSeconds),
        },
        counts: overview.counts,
        generatedAt: overview.generatedAt,
        health: overview.health,
        instances,
        meters: systemMeters(overview),
        query,
    };
}

export function selectTuiOverviewFocusIds(state: TuiAppState): string[] {
    return selectTuiOverviewPresentation(state).instances.map(
        (instance) => instance.id,
    );
}

export function selectTuiOverviewInstanceName(
    focusId: string | undefined,
): string | undefined {
    const prefix = "overview-instance:";
    return focusId?.startsWith(prefix)
        ? focusId.slice(prefix.length)
        : undefined;
}

export function overviewInstanceViewportRows(viewportRows: number): number {
    return Math.max(1, Math.floor(Math.max(0, viewportRows - 10) * 0.45));
}

export function selectTuiOverviewInstanceViewport(
    state: TuiAppState,
    viewportRows: number,
): TuiOverviewInstanceViewport {
    const model = selectTuiOverviewPresentation(state);
    const visibleRowCount = overviewInstanceViewportRows(viewportRows);
    const maxOffset = Math.max(0, model.instances.length - visibleRowCount);
    const offset = Math.min(
        Math.max(
            state.ui.scrollOffsets[currentTuiRouteScrollKey(state)] ?? 0,
            0,
        ),
        maxOffset,
    );
    return {
        offset,
        rows: model.instances.slice(offset, offset + visibleRowCount),
        visibleRowCount,
    };
}

function toInstanceRow(
    instance: OperationalOverviewInstance,
    todos: number,
    focused: boolean,
): TuiOverviewInstanceRowModel {
    const snapshot = instance.snapshot;
    return {
        approvals: instance.pendingApprovals,
        connection: snapshot.connectionState,
        daemon: snapshot.daemonState,
        focused,
        id: `overview-instance:${instance.name}`,
        lastError: snapshot.lastErrorMessage,
        mcpEnabled: instance.mcpEnabled,
        name: instance.name,
        provider: instance.provider,
        runtime: snapshot.status,
        todos,
        tone: instanceTone(instance),
        workspace: instance.workspace,
    };
}

function instanceTone(instance: OperationalOverviewInstance): TuiOverviewTone {
    const snapshot = instance.snapshot;
    if (
        snapshot.status === "failed" ||
        snapshot.connectionState === "failed" ||
        snapshot.daemonState === "failed"
    ) {
        return "danger";
    }
    if (snapshot.ready) return "success";
    if (
        snapshot.status === "running" ||
        snapshot.daemonState === "running" ||
        snapshot.connectionState === "connecting"
    ) {
        return "accent";
    }
    return "warning";
}

function toActivityRow(
    activity: OperationalOverviewActivity,
): TuiOverviewActivityRowModel {
    return {
        callId: activity.callId,
        duration: activityDuration(activity),
        instance: activity.instance,
        startedAt: activity.startedAt,
        status: activity.status,
        tone: activityTone(activity.status),
        toolName: activity.toolName,
    };
}

function activityDuration(activity: OperationalOverviewActivity): string {
    if (activity.completedAt === undefined) return "running";
    const started = Date.parse(activity.startedAt);
    const completed = Date.parse(activity.completedAt);
    if (
        !Number.isFinite(started) ||
        !Number.isFinite(completed) ||
        completed < started
    )
        return "—";
    const milliseconds = completed - started;
    return milliseconds < 1_000
        ? `${milliseconds}ms`
        : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function activityTone(
    status: OperationalOverviewActivity["status"],
): TuiOverviewTone {
    if (status === "failed" || status === "denied" || status === "queueTimeout")
        return "danger";
    if (status === "running" || status === "queued") return "accent";
    if (status === "completed") return "success";
    return "muted";
}

function systemMeters(overview: OperationalOverview): TuiOverviewMeterModel[] {
    const system = overview.controller.system;
    if (system === undefined) return [];

    const memoryUsed = Math.max(
        0,
        system.memoryTotalBytes - system.memoryAvailableBytes,
    );
    const meters: TuiOverviewMeterModel[] = [
        {
            detail: `${system.cpuCount} CPUs${system.load1m === undefined ? "" : ` · load ${system.load1m.toFixed(2)}`}`,
            label: "CPU",
            percent: system.cpuPercent,
            tone: meterTone(system.cpuPercent),
            value: formatOverviewPercent(system.cpuPercent),
        },
        {
            detail: `${formatOverviewBytes(memoryUsed)} / ${formatOverviewBytes(system.memoryTotalBytes)}`,
            label: "Memory",
            percent: system.memoryPercent,
            tone: meterTone(system.memoryPercent),
            value: formatOverviewPercent(system.memoryPercent),
        },
    ];

    if (
        system.diskTotalBytes !== undefined &&
        system.diskAvailableBytes !== undefined
    ) {
        const diskUsed = Math.max(
            0,
            system.diskTotalBytes - system.diskAvailableBytes,
        );
        meters.push({
            detail: `${formatOverviewBytes(diskUsed)} / ${formatOverviewBytes(system.diskTotalBytes)}${system.diskPath === undefined ? "" : ` · ${system.diskPath}`}`,
            label: "Disk",
            percent: system.diskPercent,
            tone: meterTone(system.diskPercent),
            value: formatOverviewPercent(system.diskPercent),
        });
    }
    return meters;
}

function meterTone(percent: number | undefined): TuiOverviewTone {
    if (percent === undefined) return "muted";
    if (percent >= 90) return "danger";
    if (percent >= 75) return "warning";
    return "success";
}

function controllerSummary(overview: OperationalOverview): string {
    const counts = overview.counts;
    return [
        `instances ${counts.instancesReady}/${counts.instancesTotal} ready`,
        `approvals ${counts.pendingApprovals}`,
        `todos ${counts.activeTodos}`,
        `failed calls 24h ${counts.failedCalls24h}`,
    ].join(" · ");
}

function instanceSearchText(row: TuiOverviewInstanceRowModel): string {
    return [
        row.name,
        row.provider,
        row.runtime,
        row.connection,
        row.daemon,
        row.workspace ?? "",
        row.lastError ?? "",
    ]
        .join(" ")
        .toLowerCase();
}

function toneRank(tone: TuiOverviewTone): number {
    switch (tone) {
        case "danger":
            return 0;
        case "warning":
            return 1;
        case "accent":
            return 2;
        case "success":
            return 3;
        case "normal":
            return 4;
        case "muted":
            return 5;
    }
}
