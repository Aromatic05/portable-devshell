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
                    id: "tmux-wait",
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
    if (input.direction === "inbound" && value.kind === "call")
        return rewriteInbound(value);
    if (input.direction === "outbound") {
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
    if (value.toolName === "tmux_run" && input.wait === "block") {
        const requested = milliseconds(input.timeMs) ?? milliseconds(input.timeout) ?? WAIT_HANDOFF_MS;
        return {
            ...value,
            payload: { ...input, timeMs: Math.min(requested, WAIT_HANDOFF_MS) },
        };
    }
    if (value.toolName === "tmux_read") {
        const requested = milliseconds(input.timeMs);
        if (requested !== undefined && requested > WAIT_SYNC_MS)
            return { ...value, payload: { ...input, timeMs: WAIT_SYNC_MS } };
    }
    return value;
}

function isHandoff(value: ToolCallHookValue): boolean {
    if (value.toolName !== "tmux_run" || value.kind !== "result") return false;
    const output = record(value.payload);
    if (output?.timedOut !== true) return false;
    const deadline = milliseconds(output.timeout);
    return deadline === undefined || deadline > WAIT_HANDOFF_MS;
}

function presentHandoff(value: ToolCallHookValue): ToolCallHookValue {
    const output = record(value.payload)!;
    const { timedOut: _workerTimeout, ...rest } = output;
    const warnings = Array.isArray(rest.warnings)
        ? rest.warnings.filter((warning) => record(warning)?.code !== "tmux.blockTimeout")
        : rest.warnings;
    return { ...value, payload: { ...rest, ...(warnings === undefined ? {} : { warnings }), detached: true } };
}

function detachedTarget(value: ToolCallHookValue): string | undefined {
    const payload = record(value.payload);
    if (payload === undefined) return undefined;
    if (value.kind === "result") {
        const task = record(payload.task);
        const taskId = typeof task?.id === "string" ? task.id : undefined;
        if (taskId === undefined) return undefined;
        if (value.toolName === "tmux_run" && payload.timedOut === true) return taskId;
        if (value.toolName === "tmux_read" && payload.waitReason === "timeout") return taskId;
        return undefined;
    }
    if (value.kind !== "error" || value.toolName !== "tmux_run") return undefined;
    const error = record(payload.error);
    const details = record(error?.details);
    return error?.code === "tool.cancelled" && typeof details?.task === "string"
        ? details.task
        : undefined;
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
