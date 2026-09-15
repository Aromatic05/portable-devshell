import type {
    ApprovalDecision,
    ApprovalRequest,
    JsonValue,
    ToolCallContext,
} from "@portable-devshell/shared";

export class ApprovalError extends Error {
    readonly code: string;
    readonly details?: JsonValue;
    readonly retryable = false;

    constructor(code: string, message: string, details?: JsonValue) {
        super(message);
        this.name = "ApprovalError";
        this.code = code;
        this.details = details;
    }
}

export interface ApprovalEvaluationInput {
    callId: string;
    context: ToolCallContext;
    inputSummary: string;
    recording?: "caller" | "host";
    toolName: string;
}

export type ApprovalEvaluation =
    | { decision: "allow" }
    | { decision: "deny"; error: ApprovalError }
    | {
          awaitDecision: Promise<ApprovalResolution>;
          decision: "ask";
          request: ApprovalRequest;
      };

export type ApprovalResolution =
    | { decision: ApprovalDecision; status: "approved" }
    | { decision: ApprovalDecision; error: ApprovalError; status: "denied" }
    | { error: ApprovalError; status: "expired" }
    | { error: ApprovalError; status: "cancelled" };
