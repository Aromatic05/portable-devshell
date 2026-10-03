import type { InstanceEventRecord } from "@portable-devshell/shared";

import {
    isMcpWorkspaceGateway,
    type McpWorkspaceActionGateway,
} from "../../instance/Gateway.js";

export async function readWorkspaceCursor(
    gateway: McpWorkspaceActionGateway,
    instance: string,
): Promise<number> {
    const workspace = isMcpWorkspaceGateway(gateway) ? gateway : undefined;
    if (workspace === undefined) return 0;
    return (
        await workspace.readWorkspaceEvents(
            instance,
            Number.MAX_SAFE_INTEGER,
        )
    ).lastSeq;
}

export async function readWorkspaceBusy(
    gateway: McpWorkspaceActionGateway,
    ctxId: string,
    instances: readonly string[],
): Promise<boolean> {
    const workspace = isMcpWorkspaceGateway(gateway) ? gateway : undefined;
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

export function workspaceEventBelongsTo(
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
