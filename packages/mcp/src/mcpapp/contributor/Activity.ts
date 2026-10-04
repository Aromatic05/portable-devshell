import type { InstanceEventRecord } from "@portable-devshell/shared";

import {
    isMcpAppGateway,
    type McpAppActionGateway,
} from "../../instance/Gateway.js";

export async function readMcpAppCursor(
    gateway: McpAppActionGateway,
    instance: string,
): Promise<number> {
    const workspace = isMcpAppGateway(gateway) ? gateway : undefined;
    if (workspace === undefined) return 0;
    return (
        await workspace.readMcpAppEvents(
            instance,
            Number.MAX_SAFE_INTEGER,
        )
    ).lastSeq;
}

export async function readMcpAppBusy(
    gateway: McpAppActionGateway,
    ctxId: string,
    instances: readonly string[],
): Promise<boolean> {
    const workspace = isMcpAppGateway(gateway) ? gateway : undefined;
    if (workspace === undefined) return false;

    const activeCalls = await Promise.allSettled(
        instances.map(async (name) =>
            workspace.hasActiveToolCalls !== undefined
                ? workspace.hasActiveToolCalls(name, ctxId)
                : (await workspace.readToolCalls(name, ctxId, 64)).some(
                      (call) =>
                          call.status === "queued" ||
                          call.status === "running",
                  ),
        ),
    );
    return activeCalls.some(
        (result) => result.status === "fulfilled" && result.value,
    );
}

export function mcpAppEventBelongsTo(
    event: InstanceEventRecord,
    ctxId: string,
): boolean {
    if (
        event.type === "wait.recoveryClaimed" ||
        event.type === "wait.recoveryReleased"
    )
        return false;
    const data = record(event.data);
    return data?.ctxId === ctxId || data?.createdByCtxId === ctxId;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
