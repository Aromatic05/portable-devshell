import {
    contextErrorCodes,
    createRemoteError,
    type JsonValue,
    type ToolCallHooks,
} from "@portable-devshell/shared";
import type { ApprovalApi } from "../../approval/Api.js";
import type { TaskApi } from "../../task/Api.js";

/** The Instance owns this Execute; Hook and Audit stages are never bypassed. */
export function installMcpAppAction(
    hooks: ToolCallHooks,
    api: { approval: ApprovalApi; task: TaskApi },
): () => void {
    return hooks.registerExecute("mcpapp_action", async (_callId, payload, value, signal) => {
        signal?.throwIfAborted();
        const ctxId = value.context.ctxId;
        if (!ctxId || value.context.source !== "mcp") throw denied("A validated MCP Context is required.");
        const action = readAction(payload);
        if (action.actionId === "approve" || action.actionId === "deny") {
            const approval = await api.approval.getApproval(action.itemId);
            if (approval.ctxId !== ctxId || approval.status !== "pending")
                throw denied("The approval is no longer pending for this Context.");
            if (value.context.workspace !== approval.workspace)
                throw denied("The approval belongs to another Workspace.");
            signal?.throwIfAborted();
            await api.approval.decideApproval(action.itemId, {
                decision: action.actionId === "approve" ? "approve" : "deny",
                decidedBy: "web",
            });
        } else if (action.actionId.startsWith("goal-")) {
            if (action.expectedRevision === undefined) throw denied("Goal revision is required.");
            const goal = await api.task.goal.read(ctxId);
            if (goal?.goalId !== action.itemId || goal.workspace !== value.context.workspace)
                throw denied("The Goal is unavailable in this Context.");
            signal?.throwIfAborted();
            await api.task.goal.manage(ctxId, {
                action: action.actionId === "goal-pause" ? "pause"
                    : action.actionId === "goal-stop" ? "stop" : "resume",
                expectedGoalId: action.itemId,
                expectedRevision: action.expectedRevision,
                userControl: true,
                ...(value.context.workspace === undefined ? {} : { workspace: value.context.workspace }),
            });
        }
        return { status: "applied", itemId: action.itemId, actionId: action.actionId } as JsonValue;
    });
}

function readAction(value: JsonValue): { itemId: string; actionId: string; expectedRevision?: number } {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw denied("MCP App action input is invalid.");
    const { itemId, actionId, expectedRevision, requestId } = value;
    if (typeof itemId !== "string" || itemId.length === 0 || itemId.length > 256 ||
        typeof requestId !== "string" || requestId.length < 16 || requestId.length > 128 ||
        typeof actionId !== "string" || ![
            "approve", "deny",
            "goal-pause", "goal-resume", "goal-retry", "goal-stop",
        ].includes(actionId) ||
        (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)))
        throw denied("MCP App action input is invalid.");
    return { itemId, actionId, ...(expectedRevision === undefined ? {} : { expectedRevision: Number(expectedRevision) }) };
}

function denied(message: string) {
    return createRemoteError({ code: contextErrorCodes.invalid, message, retryable: false });
}
