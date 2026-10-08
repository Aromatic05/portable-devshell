import {
    contextErrorCodes,
    createRemoteError,
    type JsonValue,
    type ToolCallHooks,
} from "@portable-devshell/shared";
import type { TaskApi } from "../../task/Api.js";

/** Reentry is a ToolCall Execute owned by the Instance, not an MCP callback. */
export function installMcpAppReentry(hooks: ToolCallHooks, task: TaskApi): () => void {
    return hooks.registerExecute("mcpapp_reentry", async (_callId, input, value, signal) => {
        signal?.throwIfAborted();
        const ctxId = value.context.ctxId;
        if (value.context.source !== "mcp" || !ctxId)
            throw invalid("MCP App recovery requires a validated Context.");
        const request = readReentry(input);
        if (request.intent === "task-resume") {
            if (!request.sourceId) throw invalid("Task recovery requires a Task ID.");
            const state = (await task.todo.read()).tasks?.find((item) =>
                item.taskId === request.sourceId && item.ctxId === ctxId &&
                item.pausedAt === undefined && item.status !== "completed" && item.status !== "cancelled");
            if (state === undefined) {
                if (request.action === "claim") return { claimed: false };
                if (request.action === "validate") return { valid: false };
                throw invalid("Task recovery is no longer available in this Context.");
            }
            signal?.throwIfAborted();
            if (request.action === "claim") return { claimed: true };
            if (request.action === "validate") return { valid: true };
            if (request.action === "attempt") return { attempted: true };
            if (request.action === "report") return { reported: true };
            return { released: true };
        }
        const goal = task.goal;
        const current = await goal.read(ctxId);
        if (current === undefined || current.workspace !== value.context.workspace)
            throw invalid("No Goal belongs to this Context and Workspace.");
        if (request.sourceId !== undefined && current.goalId !== request.sourceId)
            throw invalid("The Goal changed; refresh recovery before retrying.");
        signal?.throwIfAborted();
        if (request.action === "claim") {
            if (!request.intent || !request.sourceId)
                throw invalid("Recovery claim requires an intent and Goal ID.");
            if (request.intent === "automatic" && !current.continuationDue)
                return { claimed: false, goal: current } as unknown as JsonValue;
            if (request.intent !== "automatic" && current.status !== "active")
                return { claimed: false, goal: current } as unknown as JsonValue;
            return await goal.continuation(ctxId, {
                action: "claim", claimId: request.claimId, goalId: request.sourceId,
                userInitiated: request.intent !== "automatic",
            });
        }
        if (request.action === "attempt" && current.continuationAttemptedAt !== undefined)
            return { attempted: false, duplicate: true };
        if (request.action === "report" && request.outcome === "uncertain")
            return { uncertain: true }; // Leave attempted Goal unresolved; never blindly replay.
        return await goal.continuation(ctxId, {
            action: request.action,
            claimId: request.claimId,
            ...(request.action === "report" ? { accepted: request.outcome === "accepted" } : {}),
        });
    });
}

function readReentry(value: JsonValue): {
    action: "claim" | "validate" | "attempt" | "report" | "release";
    claimId: string;
    sourceId?: string;
    intent?: "automatic" | "goal-resume" | "goal-retry" | "task-resume";
    outcome?: "accepted" | "rejected" | "uncertain";
} {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw invalid("Invalid recovery request.");
    const { action, claimId, sourceId, intent, outcome } = value;
    if (!["claim", "validate", "attempt", "report", "release"].includes(String(action)) ||
        typeof claimId !== "string" || !claimId || claimId.length > 128 ||
        (sourceId !== undefined && (typeof sourceId !== "string" || !sourceId || sourceId.length > 256)) ||
        (intent !== undefined && !["automatic", "goal-resume", "goal-retry", "task-resume"].includes(String(intent))) ||
        (outcome !== undefined && !["accepted", "rejected", "uncertain"].includes(String(outcome))) ||
        (action === "report" && outcome === undefined))
        throw invalid("Invalid recovery request.");
    return {
        action: action as "claim" | "validate" | "attempt" | "report" | "release",
        claimId,
        ...(typeof sourceId === "string" ? { sourceId } : {}),
        ...(typeof intent === "string" ? { intent: intent as "automatic" | "goal-resume" | "goal-retry" | "task-resume" } : {}),
        ...(typeof outcome === "string" ? { outcome: outcome as "accepted" | "rejected" | "uncertain" } : {}),
    };
}

function invalid(message: string) {
    return createRemoteError({ code: contextErrorCodes.invalid, message, retryable: false });
}
