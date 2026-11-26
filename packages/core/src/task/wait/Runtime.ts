import {
    RemoteError,
    type JsonValue,
    type ToolCallHookValue,
    type ToolCallHooks,
    type ToolCallRewriteInput,
    type WaitDetachInput,
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
    if (input.direction !== "outbound" || value.kind !== "result" || value.context.contextMode === "stateless")
        return value;
    const output = record(value.payload);
    const targetId = record(output?.task)?.id;
    if (output === undefined || typeof targetId !== "string" || !isHandoff(value.toolName, output))
        return value;

    try {
        await wait.detach(detachInput(input.callId, targetId, value));
    } catch (error) {
        // The task is already running; failure to register its observer must
        // not discard the result needed to continue polling it.
        const code = error instanceof RemoteError &&
            (error.code === "wait.commitUncertain" || error.code === "wait.commitDurabilityUnconfirmed")
            ? error.code
            : "wait.registrationFailed";
        const { detached: _detached, ...running } = output;
        return {
            ...value,
            payload: {
                ...running,
                waitError: {
                    code,
                    message: "Durable Wait registration was not confirmed. Continue with task_input using the returned task ID and cursor; do not repeat the original call.",
                },
            },
        };
    }
    return { ...value, payload: { ...output, detached: true } };
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

function isHandoff(toolName: string, output: Record<string, JsonValue>): boolean {
    if (output.termination !== "running" || output.waitReason !== "timeout")
        return false;
    if (toolName === "bash_run")
        return (milliseconds(output.waitMs) ?? 0) >= WAIT_HANDOFF_MS;
    if (toolName === "task_input")
        return (
            output.untilExit === true &&
            (milliseconds(output.waitMs) ?? 0) >= WAIT_SYNC_MS
        );
    return false;
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
