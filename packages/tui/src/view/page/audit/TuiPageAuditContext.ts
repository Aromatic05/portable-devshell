import type { ApprovalRequest, ToolCallRecord } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { auditInputSummary, auditOutputSummary } from "../../../state/audit/TuiAuditPresentation.js";
import { compactSummary, formatField, makeBox, toolCallStatus } from "../TuiPageBoxSupport.js";
import { findAuditContext } from "./TuiAuditContextProjection.js";

export function buildAuditContextBoxes(state: TuiAppState, instance: string, ctxId: string): BoxModel[] {
    const context = findAuditContext(state, instance, ctxId);
    if (context === undefined) return [];

    return [
        ...context.calls.map((call) => ({ at: call.startedAt, box: callBox(state, instance, ctxId, call) })),
        ...context.approvals.map((approval) => ({ at: approval.createdAt, box: approvalBox(state, instance, approval) }))
    ].sort((left, right) => left.at.localeCompare(right.at)).map((entry) => entry.box);
}

function callBox(state: TuiAppState, instance: string, ctxId: string, call: ToolCallRecord): BoxModel {
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Call", call.callId),
            formatField("Tool", call.toolName),
            formatField("Status", call.status),
            formatField("Started", call.startedAt),
            formatField("Completed", call.completedAt ?? "-"),
            formatField("Duration", duration(call)),
            formatField("Operation", call.requestId ?? "-"),
            { id: "input", text: `input ${auditInputSummary(call.input, call.inputSummary)}` },
            { id: "output", text: `result ${auditOutputSummary(call.output)}` },
            ...(call.error === undefined ? [] : [formatField("Error", call.error)])
        ],
        id: `audit-call:${call.callId}`,
        primaryRoute: { callId: call.callId, ctxId, page: "audit", view: "call" },
        searchText: `${call.toolName} ${call.status} ${call.callId}`,
        status: toolCallStatus(call),
        summaryLines: [compactSummary(["status", call.status], ["duration", duration(call)], ["operation", call.requestId ?? "-"])],
        title: `${call.toolName} · ${call.status}`
    });
}

function approvalBox(state: TuiAppState, instance: string, approval: ApprovalRequest): BoxModel {
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Approval", approval.approvalId),
            formatField("Tool", approval.toolName),
            formatField("Risk", approval.riskLevel),
            formatField("Reason", approval.reason),
            { id: `approval.open:${approval.approvalId}`, text: "[ Review ]", tone: "accent" }
        ],
        id: `approval-${approval.approvalId}`,
        severity: approval.riskLevel === "high" ? "danger" : "warning",
        status: approval.status === "pending" ? "pending" : "normal",
        summaryLines: [compactSummary(["approval", approval.status], ["risk", approval.riskLevel], ["tool", approval.toolName])],
        title: `Approval · ${approval.toolName}`
    });
}

function duration(call: ToolCallRecord): string {
    if (call.completedAt === undefined) return "running";
    const milliseconds = Date.parse(call.completedAt) - Date.parse(call.startedAt);
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? `${milliseconds}ms` : "-";
}
