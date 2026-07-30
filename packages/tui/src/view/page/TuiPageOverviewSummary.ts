import type { OperationalOverviewAlert } from "@portable-devshell/shared";

import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import {
    compactSummary,
    formatField,
    makeBox,
    shortenPath
} from "./TuiPageBoxSupport.js";
import type { TuiOverviewPresentation } from "./TuiOverviewPresentation.js";
import {
    formatOverviewBytes,
    formatOverviewDuration,
    formatOverviewPercent
} from "./TuiOverviewFormatting.js";

export function buildOverviewHealthBox(
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
            formatField("Uptime", formatOverviewDuration(overview.controller.uptimeSeconds)),
            ...(system === undefined ? [] : [
                formatField("CPU", `${formatOverviewPercent(system.cpuPercent)} · ${system.cpuCount} cores`),
                formatField("Load 1m", system.load1m === undefined ? "—" : String(system.load1m)),
                formatField("Memory", `${formatOverviewPercent(system.memoryPercent)} · ${formatOverviewBytes(system.memoryAvailableBytes)} available`),
                ...(system.diskPercent === undefined
                    ? []
                    : [formatField("Disk", `${formatOverviewPercent(system.diskPercent)} · ${formatOverviewBytes(system.diskAvailableBytes ?? 0)} available`)]),
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
                ["cpu", formatOverviewPercent(system?.cpuPercent)],
                ["mem", formatOverviewPercent(system?.memoryPercent)],
                ["disk", formatOverviewPercent(system?.diskPercent)]
            )
        ],
        title: "Operational Health"
    });
}

export function buildOverviewAlertBoxes(
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
