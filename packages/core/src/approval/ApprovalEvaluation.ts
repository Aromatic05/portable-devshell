import type { ApprovalDecision, ApprovalRequest, ToolCallContext } from "@portable-devshell/shared";

import type { ApprovalError } from "./ApprovalError.js";

export interface ApprovalEvaluationInput {
    callId: string;
    context: ToolCallContext;
    inputSummary: string;
    toolName: string;
}

export type ApprovalEvaluation =
    | { decision: "allow" }
    | { decision: "deny"; error: ApprovalError }
    | { awaitDecision: Promise<ApprovalResolution>; decision: "ask"; request: ApprovalRequest };

export type ApprovalResolution =
    | { decision: ApprovalDecision; status: "approved" }
    | { decision: ApprovalDecision; error: ApprovalError; status: "denied" }
    | { error: ApprovalError; status: "expired" }
    | { error: ApprovalError; status: "cancelled" };
