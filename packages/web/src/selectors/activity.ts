import type { InstanceEvent } from "@portable-devshell/shared/browser";

export type ActivityResult = "all" | "failure" | "pending" | "success" | "other";
export type ActivityPeriod = "all" | "1h" | "24h";

export interface ActivityFilters {
    instance: string;
    period: ActivityPeriod;
    query: string;
    result: ActivityResult;
    type: string;
}

export const emptyActivityFilters: ActivityFilters = {
    instance: "all",
    period: "all",
    query: "",
    result: "all",
    type: "all",
};

const failureEvents = new Set([
    "approval.denied",
    "approval.expired",
    "instance.connectionChanged:failed",
    "reverse.disconnected",
    "toolCall.cancelled",
    "toolCall.denied",
    "toolCall.expired",
    "toolCall.failed",
    "toolCall.queueTimeout",
    "worker.rpcDisconnected",
]);

const pendingEvents = new Set([
    "approval.requested",
    "instance.connectionChanged:connecting",
    "instance.connectionChanged:reconnecting",
    "toolCall.pendingApproval",
    "toolCall.queued",
    "toolCall.running",
    "toolCall.started",
]);

const successEvents = new Set([
    "approval.approved",
    "instance.started",
    "instance.stopped",
    "reverse.connected",
    "toolCall.completed",
    "worker.rpcConnected",
]);

export function activityResult(event: InstanceEvent): Exclude<ActivityResult, "all"> {
    const connectionState = readConnectionState(event);
    const classifiedType = connectionState === undefined
        ? event.type
        : `${event.type}:${connectionState}`;
    if (failureEvents.has(classifiedType)) return "failure";
    if (pendingEvents.has(classifiedType)) return "pending";
    if (successEvents.has(classifiedType)) return "success";
    return "other";
}

export function filterActivity(
    events: readonly InstanceEvent[],
    filters: ActivityFilters,
    now = Date.now(),
): InstanceEvent[] {
    const query = filters.query.trim().toLowerCase();
    const minTime = filters.period === "1h" ? now - 3_600_000 : filters.period === "24h" ? now - 86_400_000 : undefined;
    return [...events]
        .reverse()
        .filter((event) => filters.instance === "all" || event.instanceName === filters.instance)
        .filter((event) => filters.type === "all" || event.type === filters.type)
        .filter((event) => filters.result === "all" || activityResult(event) === filters.result)
        .filter((event) => minTime === undefined || Date.parse(event.at) >= minTime)
        .filter((event) => query.length === 0 || `${event.instanceName} ${event.type}`.toLowerCase().includes(query))
        .slice(0, 100);
}

export function hasActiveActivityFilters(filters: ActivityFilters): boolean {
    return Object.entries(filters).some(([key, value]) => key !== "period" ? value !== "all" && value !== "" : value !== "all");
}

function readConnectionState(event: InstanceEvent): string | undefined {
    if (event.type !== "instance.connectionChanged") return undefined;
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
    const state = data.connectionState ?? data.state;
    return typeof state === "string" ? state : undefined;
}
