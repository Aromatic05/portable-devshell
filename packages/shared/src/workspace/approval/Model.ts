// Tool approval domain model. Decisions are owned by the instance approval
// service; the client treats the pending list as an authoritative snapshot
// plus an event cursor. Approval policy is Config vocabulary and lives in
// control/config/Type.ts.

import type { InstanceEventRecord } from "../../client/Stream.js";
import type { InstanceName } from "../../types/Instance.js";
import type { JsonValue } from "../../types/Json.js";

type ApprovalSource = "cli" | "tui" | "web" | "mcp" | "extension";

export type ApprovalStatus =
    "pending" | "approved" | "denied" | "expired" | "cancelled";
export type ApprovalDecisionValue = "approve" | "deny";
export type ApprovalDecisionBy = "cli" | "tui" | "web" | "policy";
export type ApprovalRiskLevel = "low" | "medium" | "high";
export type ApprovalEventType =
    | "approval.requested"
    | "approval.approved"
    | "approval.denied"
    | "approval.expired"
    | "approval.cancelled";
export type ApprovalEvent = InstanceEventRecord<ApprovalEventType>;
export function isApprovalEventType(type: string): type is ApprovalEventType {
    return type.startsWith("approval.");
}

export interface ApprovalDecisionOptions {
    policyPatch?: JsonValue;
    reason?: string;
    remember?: boolean;
}

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
    source: ApprovalSource;
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

export interface ApprovalTimeout {
    ms: number;
}

export interface ApprovalListResult {
    approvals: ApprovalRequest[];
    /** Instance event sequence at read time. Subscribe from lastSeq + 1. */
    lastSeq: number;
}
