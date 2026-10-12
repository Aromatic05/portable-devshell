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
        } else if (action.actionId.startsWith("question-answer-")) {
            // Questions are MCP App-owned; the enclosing MCP endpoint commits
            // their answer only after this reviewed and audited Execute.
            signal?.throwIfAborted();
            return { status: "applied", itemId: action.itemId,
                actionId: action.actionId, input: action.input } as JsonValue;
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
        } else {
            if (action.expectedRevision === undefined) throw denied("Task revision is required.");
            // A targeted Todo read returns the task's items, not the task
            // summaries carrying Context ownership. Read the active catalog
            // before the revision-checked mutation.
            const todo = await api.task.todo.read();
            if (!todo.tasks?.some((task) => task.taskId === action.itemId && task.ctxId === ctxId))
                throw denied("The Task is unavailable in this Context.");
            signal?.throwIfAborted();
            await api.task.todo.control(
                action.itemId,
                action.actionId === "task-pause" ? "pause"
                    : action.actionId === "task-resume" ? "resume" : "cancel",
                ctxId,
                action.expectedRevision,
            );
        }
        return { status: "applied", itemId: action.itemId, actionId: action.actionId } as JsonValue;
    });
}

function readAction(value: JsonValue): { itemId: string; actionId: string; expectedRevision?: number; input?: string } {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw denied("MCP App action input is invalid.");
    const { itemId, actionId, expectedRevision, requestId, input } = value;
    if (typeof itemId !== "string" || itemId.length === 0 || itemId.length > 256 ||
        typeof requestId !== "string" || requestId.length < 16 || requestId.length > 128 ||
        typeof actionId !== "string" || ![
            "approve", "deny", "task-pause", "task-resume", "task-cancel",
            "goal-pause", "goal-resume", "goal-retry", "goal-stop",
            "question-answer-text", "question-answer-choice",
        ].includes(actionId) ||
        (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)) ||
        (actionId.startsWith("question-answer-") && (typeof input !== "string" || !input.trim() || input.length > 4000)))
        throw denied("MCP App action input is invalid.");
    return { itemId, actionId, ...(expectedRevision === undefined ? {} : { expectedRevision: Number(expectedRevision) }),
        ...(typeof input === "string" ? { input } : {}) };
}

function denied(message: string) {
    return createRemoteError({ code: contextErrorCodes.invalid, message, retryable: false });
}
