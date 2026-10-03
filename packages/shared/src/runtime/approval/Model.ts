// Tool approval domain model. Decisions and policy are owned by the instance
// approval service; the client treats the pending list as an authoritative
// snapshot plus an event cursor.

import type { InstanceName } from "../identity/Model.js";
import type { ToolCallSource } from "../tool/Model.js";
import type { JsonValue } from "../../transport/primitive/JsonValue.js";

export type ApprovalStatus =
    | "pending"
    | "approved"
    | "denied"
    | "expired"
    | "cancelled";
export type ApprovalDecisionValue = "approve" | "deny";
export type ApprovalDecisionBy = "cli" | "tui" | "web" | "policy";
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
    recording?: "caller" | "host";
    requestId?: string;
    riskLevel: ApprovalRiskLevel;
    ctxId?: string;
    extensionId?: string;
    source: ToolCallSource;
    status: ApprovalStatus;
    terminalAt?: string;
    toolName: string;
    workspace?: string;
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

export interface ApprovalListResult {
    approvals: ApprovalRequest[];
    /** Instance event sequence at read time. Subscribe from lastSeq + 1. */
    lastSeq: number;
}

export function isApprovalEvent(type: string): boolean {
    return type.startsWith("approval.");
}
