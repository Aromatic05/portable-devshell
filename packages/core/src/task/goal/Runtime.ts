import {
    contextErrorCodes,
    createRemoteError,
    type GoalManageInput,
    type JsonValue,
    type ToolCallHooks,
} from "@portable-devshell/shared";
import type { GoalApi } from "../Api.js";

export function installWorkspaceGoalTool(hooks: ToolCallHooks, goal: GoalApi): () => void {
    return hooks.registerExecute("workspace_goal", async (_callId, input, value, signal) => {
        signal?.throwIfAborted();
        const ctxId = value.context.ctxId;
        if (!ctxId) throw createRemoteError({
            code: contextErrorCodes.invalid,
            message: "workspace_goal requires a validated Context.",
            retryable: false,
        });
        if (input === null || typeof input !== "object" || Array.isArray(input))
            throw new TypeError("workspace_goal requires an object input.");
        const { action, objective, note, expectedRevision, expectedGoalId } = input;
        if (typeof action !== "string" || !["get", "start", "update", "block", "finish"].includes(action))
            throw new TypeError("workspace_goal requires get, start, update, block or finish.");
        const mutation: GoalManageInput = {
            action: action as GoalManageInput["action"],
            ...(typeof objective === "string" ? { objective } : {}),
            ...(typeof note === "string" ? { note } : {}),
            ...(typeof expectedRevision === "number" ? { expectedRevision } : {}),
            ...(typeof expectedGoalId === "string" ? { expectedGoalId } : {}),
            workspace: value.context.workspace,
        };
        // The field set is constrained by the published MCP schema. Never pass
        // caller-supplied userControl or a Client-owned ctxId to the Goal service.
        const current = action === "get" ? await goal.read(ctxId)
            : await goal.manage(ctxId, mutation);
        signal?.throwIfAborted();
        return { goal: current ?? null } as unknown as JsonValue;
    });
}
