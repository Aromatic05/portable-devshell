import { runtimeErrorCodes, type JsonValue, type ToolCallContext } from "@portable-devshell/shared";
import type { McpWorkspaceActionGateway } from "../instance/Gateway.js";
import { readWorkspaceProjection } from "./Projection.js";
import type { WorkspaceActionEffect, WorkspaceActionRequest, WorkspaceResolvedAction, WorkspaceSnapshot } from "./model/Contract.js";
import { WorkspaceActionStore } from "./ActionStore.js";

const contextQueues = new Map<string, Promise<void>>();

export interface WorkspaceActionRouterOptions {
    store: WorkspaceActionStore;
    instance: string;
    contextInstances(ctxId: string): Promise<string[]>;
    reentry(ctxId: string): Promise<JsonValue | undefined>;
    snapshot(gateway: McpWorkspaceActionGateway, ctxId: string, directives: WorkspaceActionEffect[]): Promise<WorkspaceSnapshot>;
    mutate(action: WorkspaceResolvedAction, request: WorkspaceActionRequest, context: ToolCallContext): Promise<WorkspaceActionEffect | undefined>;
}

export async function executeWorkspaceAction(
    options: WorkspaceActionRouterOptions,
    gateway: McpWorkspaceActionGateway,
    request: WorkspaceActionRequest,
    context: ToolCallContext,
): Promise<JsonValue> {
    if (request.input !== undefined && request.input.length > 20_000) throw new Error("workspace_action input must be at most 20000 characters.");
    const ctxId = context.ctxId;
    if (typeof ctxId !== "string" || ctxId.length === 0) throw new Error("Workspace action requires a Context.");
    const key = ctxId;
    const previous = contextQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    contextQueues.set(key, current);
    await previous;
    try {
        const existing = await options.store.get(request.actionId);
        if (existing !== undefined) {
            if (existing.ctxId !== ctxId || existing.instance !== options.instance) throw new Error("Workspace action receipt scope does not match the current Context and instance.");
            if (existing.resolved.itemId !== request.itemId) throw new Error("Workspace action receipt item does not match the request.");
            if (existing.status === "prepared") throw new Error("Workspace action outcome is uncertain; the prepared action is not replayed.");
            if (existing.status === "conflicted") {
                const directives = await options.store.pendingDirectives(ctxId, options.instance);
                return { status: "stale", snapshot: await options.snapshot(gateway, ctxId, directives) } as unknown as JsonValue;
            }
            const directives = await options.store.pendingDirectives(ctxId, options.instance);
            const snapshot = await options.snapshot(gateway, ctxId, directives);
            return { status: "stale", snapshot } as unknown as JsonValue;
        }
        const projection = await readWorkspaceProjection(gateway, options.instance, ctxId, {
            instances: await options.contextInstances(ctxId),
            reentry: await options.reentry(ctxId),
        });
        const action = projection.actions.find((candidate) => candidate.itemId === request.itemId && candidate.actionId === request.actionId);
        if (action === undefined) {
            const directives = await options.store.pendingDirectives(ctxId, options.instance);
            return { status: "stale", snapshot: await options.snapshot(gateway, ctxId, directives) } as unknown as JsonValue;
        }
        await options.store.prepare(ctxId, options.instance, action);
        let effect: WorkspaceActionEffect | undefined;
        try {
            effect = await options.mutate(action, request, context);
        } catch (error) {
            if (!isKnownConflict(error)) throw error;
            await options.store.conflict(action.actionId);
            const directives = await options.store.pendingDirectives(ctxId, options.instance);
            return { status: "stale", snapshot: await options.snapshot(gateway, ctxId, directives) } as unknown as JsonValue;
        }
        if (effect !== undefined) effect = { ...effect, id: action.actionId };
        await options.store.apply(action.actionId, effect);
        const directives = await options.store.pendingDirectives(ctxId, options.instance);
        return {
            status: "applied",
            snapshot: await options.snapshot(gateway, ctxId, directives),
            ...(effect === undefined ? {} : { effect }),
        } as unknown as JsonValue;
    } finally {
        release();
        if (contextQueues.get(key) === current) contextQueues.delete(key);
    }
}

function isKnownConflict(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return code === runtimeErrorCodes.todoRevisionConflict || code === runtimeErrorCodes.approvalAlreadyDecided;
}
