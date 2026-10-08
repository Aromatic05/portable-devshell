import type { JsonValue, ToolCallHooks } from "@portable-devshell/shared";
import type { ApprovalApi, ApprovalEvaluationApi, ApprovalEvaluationError } from "../Api.js";

export function registerApprovalToolCallReview(
    hooks: ToolCallHooks,
    approval: ApprovalEvaluationApi & Partial<Pick<ApprovalApi, "getApproval">>,
): () => void {
    return hooks.registerReview({
        hook: "510-approval",
        id: "approval",
        review: async (input, runtime) => {
        if (input.direction !== "inbound" || input.value.kind !== "call") {
            return { decision: "continue" };
        }

        const { source, requestId, ctxId, workspace } = input.value.context;
        // Resolving an existing approval must not request approval for its own
        // decision. Only a validated MCP Context may resolve its pending item;
        // every other action continues through the configured approval policy.
        if (input.value.toolName === "mcpapp_action" && source === "mcp" &&
            typeof input.value.payload === "object" && input.value.payload !== null &&
            !Array.isArray(input.value.payload) &&
            (input.value.payload.actionId === "approve" || input.value.payload.actionId === "deny")) {
            const itemId = input.value.payload.itemId;
            if (typeof itemId !== "string" || !ctxId || approval.getApproval === undefined)
                return { decision: "reject", reason: "A validated approval Context is required." };
            try {
                const pending = await approval.getApproval(itemId);
                if (pending.status === "pending" && pending.ctxId === ctxId && pending.workspace === workspace)
                    return { decision: "continue" };
            } catch { /* The approval is missing or unavailable to this Context. */ }
            return { decision: "reject", reason: "This approval is no longer pending for the Context." };
        }
        const evaluation = await approval.evaluate(
            {
                callId: input.callId,
                source,
                requestId,
                ctxId,
                workspace,
                inputSummary: summarize(input.value.payload),
                recording: runtime.recording,
                toolName: input.value.toolName,
            },
            runtime.signal,
        );
        if (evaluation.decision === "allow") return { decision: "continue" };
        if (evaluation.decision === "deny") {
            return reject(evaluation.error);
        }

        const resolution = await evaluation.awaitDecision;
        if (resolution.status === "approved") {
            return { decision: "continue" };
        }
        return reject(resolution.error);
        },
    });
}

function summarize(value: JsonValue): string {
    const summary =
        Array.isArray(value) || (typeof value === "object" && value !== null)
            ? (JSON.stringify(value) ?? "null")
            : String(value);
    return summary.length <= 512 ? summary : `${summary.slice(0, 511)}…`;
}

function reject(error: ApprovalEvaluationError) {
    return {
        decision: "reject" as const,
        error: { code: error.code },
        reason: error.message,
    };
}
