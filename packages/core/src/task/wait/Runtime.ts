import type {
    JsonValue,
    ToolCallHookValue,
    ToolCallHooks,
    WaitDetachInput,
} from "@portable-devshell/shared";
import type { WaitApi } from "../Api.js";
import { WAIT_SYNC_MS } from "./index.js";

export function installWaitToolCallRewrite(
    hooks: ToolCallHooks,
    wait: WaitApi,
): () => void {
    return hooks.registerContributor(() => ({
            rewrites: [
                {
                    hook: "520-wait-detach",
                    id: "tmux-wait",
                    async rewrite(input) {
                        const { value } = input;
                        if (input.direction === "inbound" && value.kind === "call")
                            return rewriteInbound(value);
                        if (input.direction === "outbound") {
                            const targetId = detachedTarget(value);
                            if (targetId !== undefined)
                                await wait.detach(detachInput(input.callId, targetId, value));
                        }
                        return value;
                    },
                },
            ],
            release() {},
        }));
}

function rewriteInbound(value: ToolCallHookValue): ToolCallHookValue {
    const input = record(value.payload);
    if (input === undefined) return value;
    if (value.toolName === "tmux_run" && input.wait === "block") {
        const requested = milliseconds(input.timeMs) ?? milliseconds(input.timeout) ?? WAIT_SYNC_MS;
        return {
            ...value,
            payload: { ...input, timeMs: Math.min(requested, WAIT_SYNC_MS) },
        };
    }
    if (value.toolName === "tmux_read") {
        const requested = milliseconds(input.timeMs);
        if (requested !== undefined && requested > WAIT_SYNC_MS)
            return { ...value, payload: { ...input, timeMs: WAIT_SYNC_MS } };
    }
    return value;
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
