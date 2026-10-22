import {
    type OperationalOverview,
    type OperationalOverviewActivity,
    type OperationalOverviewAlert,
} from "@portable-devshell/shared";

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
    if (kind.startsWith("activity.")) return "#/audit";
    if (kind.startsWith("instance.")) return "#/instances";
    return "#/overview";
}
