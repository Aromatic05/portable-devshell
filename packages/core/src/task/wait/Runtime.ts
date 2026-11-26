import type {
    JsonValue,
    ToolCallHookValue,
    ToolCallHooks,
    ToolCallRewriteInput,
    WaitDetachInput,
} from "@portable-devshell/shared";
import type { WaitApi } from "../Api.js";
import { WAIT_HANDOFF_MS, WAIT_SYNC_MS } from "./index.js";

export function installWaitToolCallRewrite(
    hooks: ToolCallHooks,
    wait: WaitApi,
): () => void {
    return hooks.registerContributor(() => ({
            rewrites: [
                {
                    hook: "520-wait-detach",
                    id: "task-wait",
                    rewrite: (input) => rewriteWaitToolCall(input, wait),
                },
            ],
            release() {},
        }));
}

/** Run at the destination Instance so detached tasks use its Worker and state. */
export async function rewriteWaitToolCall(
    input: ToolCallRewriteInput,
    wait: WaitApi,
): Promise<ToolCallHookValue> {
    const { value } = input;
    if (input.direction === "inbound" && value.kind === "call" && value.context.contextMode !== "stateless")
        return rewriteInbound(value);
    if (input.direction === "outbound" && value.context.contextMode !== "stateless") {
        const targetId = detachedTarget(value);
        if (targetId !== undefined) {
            await wait.detach(detachInput(input.callId, targetId, value));
            if (isHandoff(value)) return presentHandoff(value);
        }
    }
    return value;
}

function rewriteInbound(value: ToolCallHookValue): ToolCallHookValue {
    const input = record(value.payload);
    if (input === undefined) return value;
    if (value.toolName === "bash_run") {
        const requested = milliseconds(input.waitMs);
        if (requested !== undefined && requested > WAIT_HANDOFF_MS)
            return { ...value, payload: { ...input, waitMs: WAIT_HANDOFF_MS } };
    }
    if (value.toolName === "task_input") {
        const requested = milliseconds(input.waitMs);
        if (requested !== undefined && requested > WAIT_SYNC_MS)
            return { ...value, payload: { ...input, waitMs: WAIT_SYNC_MS } };
    }
    return value;
}

function isHandoff(value: ToolCallHookValue): boolean {
    if (value.kind !== "result") return false;
    const output = record(value.payload);
    if (output?.termination !== "running" || output.waitReason !== "timeout")
        return false;
    if (value.toolName === "bash_run")
        return (milliseconds(output.waitMs) ?? 0) >= WAIT_HANDOFF_MS;
    if (value.toolName === "task_input")
        return (
            output.untilExit === true &&
            (milliseconds(output.waitMs) ?? 0) >= WAIT_SYNC_MS
        );
    return false;
}

function presentHandoff(value: ToolCallHookValue): ToolCallHookValue {
    return { ...value, payload: { ...record(value.payload)!, detached: true } };
}

function detachedTarget(value: ToolCallHookValue): string | undefined {
    if (value.kind !== "result") return undefined;
    const output = record(value.payload);
    const task = record(output?.task);
    if (typeof task?.id !== "string") return undefined;
    return isHandoff(value) ? task.id : undefined;
}

function detachInput(
    callId: string,
    targetId: string,
    value: ToolCallHookValue,
): WaitDetachInput {
    return {
        callId,
        ...(value.context.ctxId === undefined ? {} : { ctxId: value.context.ctxId }),
        instance: value.context.instance,
        source: value.context.source,
        targetId,
        toolName: value.toolName,
        ...(value.context.workspace === undefined
            ? {}
            : { workspace: value.context.workspace }),
    };
}

function milliseconds(value: JsonValue | undefined): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function record(value: unknown): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, JsonValue>)
        : undefined;
}
