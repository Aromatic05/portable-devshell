import { runtimeErrorCodes, type JsonValue, type ToolCallContext, type WaitRecord } from "@portable-devshell/shared";
import type { McpInteractionGateway } from "../endpoint/Port.js";
import { readWorkspaceProjection } from "./Snapshot.js";
import type { WorkspaceActionEffect, WorkspaceActionRequest, WorkspaceResolvedAction, WorkspaceSnapshot } from "./Contract.js";
import { WorkspaceActionStore } from "./ActionStore.js";

const contextQueues = new Map<string, Promise<void>>();

export class WorkspaceActionStaleError extends Error {
    constructor() {
        super("Workspace action is no longer available.");
        this.name = "WorkspaceActionStaleError";
    }
}

export function validateWorkspaceQuestionAnswer(wait: WaitRecord, answer: string): void {
    const payload = typeof wait.payload === "object" && wait.payload !== null && !Array.isArray(wait.payload)
        ? wait.payload as Record<string, JsonValue>
        : {};
    const choices = Array.isArray(payload.choices)
        ? payload.choices.filter((choice): choice is string => typeof choice === "string")
        : [];
    if (payload.allowText === false && !choices.includes(answer)) throw new Error("Answer must be one of the offered choices.");
}

export function validateWorkspaceDirectiveClaim(directiveId: string, claimId: unknown): void {
    if (claimId !== `workspace-action-${directiveId}`) {
        throw new Error("Workspace re-entry claim does not match its directive.");
    }
}

export function readWorkspaceDeliveryOutcome(value: unknown): "accepted" | "rejected" | "uncertain" {
    if (value !== "accepted" && value !== "rejected" && value !== "uncertain") {
        throw new Error("Workspace re-entry report outcome is invalid.");
    }
    return value;
}

export function workspaceWaitReentryEffect(result: JsonValue, sourceId: string): WorkspaceActionEffect | undefined {
    return isRecord(result)?.detached === true
        ? { kind: "reentry", intent: "automatic", sourceId }
        : undefined;
}

export async function attemptWorkspaceDelivery(
    store: WorkspaceActionStore,
    directiveId: string,
    attempt: () => Promise<JsonValue>,
): Promise<JsonValue> {
    if (await store.beginDelivery(directiveId) === undefined) return { attempted: false, duplicate: true };
    const result = await attempt();
    const attempted = isRecord(result)?.attempted === true;
    if (attempted) await store.markAttempted(directiveId);
    else await store.restoreDelivery(directiveId);
    return result;
}

export async function reportWorkspaceDelivery(
    store: WorkspaceActionStore,
    directiveId: string,
    outcome: "accepted" | "rejected" | "uncertain",
    report: () => Promise<JsonValue>,
): Promise<JsonValue> {
    const receipt = await store.get(directiveId);
    if (receipt?.status === "settled") return { reported: true, duplicate: true, outcome: receipt.outcome ?? null };
    if (await store.beginReport(directiveId, outcome) === undefined) return { reported: false, duplicate: true };
    const result = await report();
    await store.settle(directiveId, outcome);
    return result;
}

export interface WorkspaceActionRouterOptions {
    store: WorkspaceActionStore;
    instance: string;
    contextInstances(ctxId: string): Promise<string[]>;
    reentry(ctxId: string): Promise<JsonValue | undefined>;
    snapshot(gateway: McpInteractionGateway, ctxId: string, directives: WorkspaceActionEffect[]): Promise<WorkspaceSnapshot>;
    preflight?(action: WorkspaceResolvedAction, request: WorkspaceActionRequest, context: ToolCallContext): Promise<void>;
    mutate(action: WorkspaceResolvedAction, request: WorkspaceActionRequest, context: ToolCallContext): Promise<WorkspaceActionEffect | undefined>;
}

export async function executeWorkspaceAction(
    options: WorkspaceActionRouterOptions,
    gateway: McpInteractionGateway,
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
        try {
            await options.preflight?.(action, request, context);
        } catch (error) {
            if (!(error instanceof WorkspaceActionStaleError)) throw error;
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

function isRecord(value: unknown): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, JsonValue>
        : undefined;
}
