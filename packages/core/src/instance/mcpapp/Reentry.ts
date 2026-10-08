import {
    contextErrorCodes,
    createRemoteError,
    type JsonValue,
    type ToolCallHooks,
} from "@portable-devshell/shared";
import type { GoalApi } from "../../task/Api.js";

/** Reentry is a ToolCall Execute owned by the Instance, not an MCP callback. */
export function installMcpAppReentry(hooks: ToolCallHooks, goal: GoalApi): () => void {
    return hooks.registerExecute("mcpapp_reentry", async (_callId, input, value, signal) => {
        signal?.throwIfAborted();
        const ctxId = value.context.ctxId;
        if (value.context.source !== "mcp" || !ctxId)
            throw invalid("MCP App recovery requires a validated Context.");
        const request = readReentry(input);
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
    intent?: "automatic" | "goal-resume" | "goal-retry";
    outcome?: "accepted" | "rejected" | "uncertain";
} {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw invalid("Invalid recovery request.");
    const { action, claimId, sourceId, intent, outcome } = value;
    if (!["claim", "validate", "attempt", "report", "release"].includes(String(action)) ||
        typeof claimId !== "string" || !claimId || claimId.length > 128 ||
        (sourceId !== undefined && (typeof sourceId !== "string" || !sourceId || sourceId.length > 256)) ||
        (intent !== undefined && !["automatic", "goal-resume", "goal-retry"].includes(String(intent))) ||
        (outcome !== undefined && !["accepted", "rejected", "uncertain"].includes(String(outcome))) ||
        (action === "report" && outcome === undefined))
        throw invalid("Invalid recovery request.");
    return {
        action: action as "claim" | "validate" | "attempt" | "report" | "release",
        claimId,
        ...(typeof sourceId === "string" ? { sourceId } : {}),
        ...(typeof intent === "string" ? { intent: intent as "automatic" | "goal-resume" | "goal-retry" } : {}),
        ...(typeof outcome === "string" ? { outcome: outcome as "accepted" | "rejected" | "uncertain" } : {}),
    };
}

function invalid(message: string) {
    return createRemoteError({ code: contextErrorCodes.invalid, message, retryable: false });
}
