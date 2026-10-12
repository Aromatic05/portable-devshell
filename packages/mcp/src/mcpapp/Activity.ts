import type { InstanceEventRecord, InstanceRuntimeTransport } from "@portable-devshell/shared";

export interface McpAppActivity {
    callId: string;
    name: string;
    state: "queued" | "running" | "completed" | "failed" | "denied" | "cancelled" | "queueTimeout";
    at: string;
    exitCode?: number;
}

const statuses = new Set<McpAppActivity["state"]>([
    "queued", "running", "completed", "failed", "denied", "cancelled", "queueTimeout",
]);

/** Project audited Instance events into a Context-specific, content-free timeline.
 * Never return raw ToolCall input/output or events belonging to other Contexts.
 */
export function projectMcpAppActivity(
    events: readonly InstanceEventRecord[],
    ctxId: string,
): McpAppActivity[] {
    const byCall = new Map<string, McpAppActivity>();
    for (const event of events) {
        if (!event.type.startsWith("toolCall.")) continue;
        const state = event.type.slice("toolCall.".length);
        if (!statuses.has(state as McpAppActivity["state"])) continue;
        const data = event.data;
        if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
        if (data.ctxId !== ctxId || typeof data.callId !== "string" ||
            typeof data.toolName !== "string") continue;
        const value: McpAppActivity = {
            callId: data.callId, name: data.toolName,
            state: state as McpAppActivity["state"], at: event.at,
            ...(typeof data.exitCode === "number" && Number.isSafeInteger(data.exitCode)
                ? { exitCode: data.exitCode } : {}),
        };
        byCall.delete(value.callId);
        byCall.set(value.callId, value);
    }
    return [...byCall.values()].slice(-50).reverse();
}

/** Read a bounded tail from the existing Instance event ledger. The source
 * owns the history; this function does not create or persist parallel state.
 */
export async function readMcpAppActivity(
    runtime: Pick<InstanceRuntimeTransport, "readEvents">,
    ctxId: string,
    cursor: number,
): Promise<McpAppActivity[]> {
    let slice = await runtime.readEvents(Math.max(1, cursor - 250));
    if (slice.kind === "gap") slice = await runtime.readEvents(slice.nextSeq);
    return slice.kind === "events" ? projectMcpAppActivity(slice.events, ctxId) : [];
}
