import type {
    ApprovalDecision,
    ApprovalDecisionBy,
    ApprovalRequest,
    JsonValue,
} from "@portable-devshell/shared";

export interface ApprovalEvaluationInput {
    callId: string;
    source: ApprovalRequest["source"];
    requestId?: string;
    ctxId?: string;
    workspace?: string;
    inputSummary: string;
    recording?: "caller" | "host";
    required?: boolean;
    toolName: string;
}

export interface ApprovalEvaluationError {
    readonly code: string;
    readonly details?: JsonValue;
    readonly message: string;
}

export type ApprovalResolution =
    | { decision: ApprovalDecision; status: "approved" }
    | { decision: ApprovalDecision; error: ApprovalEvaluationError; status: "denied" }
    | { error: ApprovalEvaluationError; status: "expired" | "cancelled" };

export type ApprovalEvaluation =
    | { decision: "allow" }
    | { decision: "deny"; error: ApprovalEvaluationError }
    | {
          decision: "ask";
          request: ApprovalRequest;
          awaitDecision: Promise<ApprovalResolution>;
      };

export interface ApprovalEvaluationApi {
    evaluate(
        input: ApprovalEvaluationInput,
        signal?: AbortSignal,
    ): Promise<ApprovalEvaluation>;
}

export interface ApprovalDecisionInput {
    decision: ApprovalDecision["decision"];
    decidedBy: ApprovalDecisionBy;
    policyPatch?: JsonValue;
    reason?: string;
    remember?: boolean;
}

export interface ApprovalApi extends ApprovalEvaluationApi {
    cancel(approvalId: string, reason?: string): Promise<ApprovalRequest>;
    decideApproval(
        approvalId: string,
        input: ApprovalDecisionInput,
    ): Promise<ApprovalRequest>;
    getApproval(approvalId: string): Promise<ApprovalRequest>;
    listApprovals(): Promise<ApprovalRequest[]>;
    listPendingApprovals(ctxId?: string): Promise<ApprovalRequest[]>;
}
