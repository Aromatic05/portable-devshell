import type { JsonValue } from "../../type/TypeJsonValue.js";
import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";
import type { ToolCallSource } from "./DtoToolCallRecord.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type ApprovalDecisionValue = "approve" | "deny";
export type ApprovalDecisionBy = "cli" | "tui" | "policy";
export type ApprovalPolicyMode = "disabled" | "allow" | "ask" | "deny";
export type ApprovalPolicyDecision = "allow" | "ask" | "deny";
export type ApprovalPolicySourceScope = ToolCallSource | "all";
export type ApprovalRiskLevel = "low" | "medium" | "high";

export interface ApprovalRequest {
    approvalId: string;
    callId: string;
    createdAt: string;
    decision?: ApprovalDecision;
    expiresAt: string;
    inputSummary: string;
    instance: InstanceName;
    reason: string;
    requestId?: string;
    riskLevel: ApprovalRiskLevel;
    ctxId?: string;
    source: ToolCallSource;
    status: ApprovalStatus;
    toolName: string;
}

export interface ApprovalDecision {
    approvalId: string;
    decidedAt: string;
    decidedBy: ApprovalDecisionBy;
    decision: ApprovalDecisionValue;
    policyPatch?: JsonValue;
    reason?: string;
    remember?: boolean;
}

export interface ApprovalPolicyRule {
    decision: ApprovalPolicyDecision;
    match: "exact";
    source: ApprovalPolicySourceScope;
    toolName?: string;
}

export interface ApprovalPolicy {
    mode: ApprovalPolicyMode;
    rules?: ApprovalPolicyRule[];
}

export interface ApprovalTimeout {
    ms: number;
}

