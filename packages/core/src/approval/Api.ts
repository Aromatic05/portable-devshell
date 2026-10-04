import type {
    ApprovalDecision,
    ApprovalDecisionBy,
    ApprovalRequest,
    JsonValue,
} from "@portable-devshell/shared";
import type { ApprovalPolicy } from "@portable-devshell/shared/config";

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

export interface ApprovalApi extends ApprovalEvaluationApi {
    cancel(approvalId: string, reason?: string): Promise<ApprovalRequest>;
    close(): void;
    decideApproval(
        approvalId: string,
        input: {
            decision: "approve" | "deny";
            decidedBy: ApprovalDecisionBy;
            policyPatch?: JsonValue;
            reason?: string;
            remember?: boolean;
        },
    ): Promise<ApprovalRequest>;
    getApproval(approvalId: string): Promise<ApprovalRequest>;
    listApprovals(): Promise<ApprovalRequest[]>;
    listPendingApprovals(ctxId?: string): Promise<ApprovalRequest[]>;
    retire(reason?: string): Promise<void>;
    setPolicy(policy: ApprovalPolicy | undefined): void;
}
