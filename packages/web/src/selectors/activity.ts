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

export function activityResult(event: InstanceEvent): Exclude<ActivityResult, "all"> {
    if (/(failed|denied|expired|cancelled|queueTimeout)/.test(event.type)) return "failure";
    if (["toolCall.queued", "toolCall.started", "toolCall.running", "toolCall.pendingApproval"].includes(event.type)) return "pending";
    if (/(completed|approved|connected|instance.started)/.test(event.type)) return "success";
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
