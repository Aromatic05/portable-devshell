import type { JsonValue } from "@portable-devshell/shared";
import type { ToolCallHooks } from "../../toolcall/Public.js";
import type { ApprovalEvaluationApi, ApprovalEvaluationError } from "../Api.js";

export function registerApprovalToolCallReview(
    hooks: ToolCallHooks,
    resolve: (instance: string) => ApprovalEvaluationApi | undefined,
): () => void {
    return hooks.registerReview({
        hook: "510-approval",
        id: "approval",
        review: async (input, runtime) => {
        if (input.direction !== "inbound" || input.value.kind !== "call") {
            return { decision: "continue" };
        }

        const service = resolve(input.value.context.instance);
        if (service === undefined) return { decision: "continue" };
        const { source, requestId, ctxId, workspace } = input.value.context;
        const evaluation = await service.evaluate(
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
