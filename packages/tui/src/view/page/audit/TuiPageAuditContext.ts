import type {
    ApprovalRequest,
    ToolCallRecord,
} from "@portable-devshell/shared";
import { workspaceFolderName } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import { selectTuiLogs, type TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import {
    auditInputSummary,
    auditOutputSummary,
    resolveAuditOutput,
} from "../../../state/audit/TuiAuditPresentation.js";
import {
    compactSummary,
    formatField,
    makeBox,
    toolCallStatus,
} from "../TuiPageBoxSupport.js";
import {
    findAuditContext,
    type TuiAuditContextKey,
} from "./TuiAuditContextProjection.js";

export function buildAuditContextBoxes(
    state: TuiAppState,
    instance: string,
    key: TuiAuditContextKey,
): BoxModel[] {
    const context = findAuditContext(state, instance, key);
    if (context === undefined) return [];

    return [
        ...context.calls.map((call) => ({
            at: call.startedAt,
            box: callBox(state, instance, key, call),
        })),
        ...context.approvals.map((approval) => ({
            at: approval.createdAt,
            box: approvalBox(state, instance, approval),
        })),
    ]
        .sort((left, right) => right.at.localeCompare(left.at))
        .map((entry) => entry.box);
}

function callBox(
    state: TuiAppState,
    instance: string,
    key: TuiAuditContextKey,
    call: ToolCallRecord,
): BoxModel {
    const output = resolveAuditOutput(
        call.output,
        selectTuiLogs(state, instance),
        call.callId,
    );
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField(
                "Context",
                key.kind === "unscoped" ? "unscoped" : key.ctxId,
            ),
            formatField("Call", call.callId),
            formatField("Tool", call.toolName),
            formatField("Status", call.status),
            formatField("Started", call.startedAt),
            formatField("Completed", call.completedAt ?? "-"),
            formatField("Duration", duration(call)),
            formatField("Workspace", call.workspace ?? "-"),
            formatField("Operation", call.requestId ?? "-"),
            {
                id: "input",
                text: formatField("Input", auditInputSummary(call.input, call.inputSummary)),
            },
            {
                id: "output",
                text: formatField("Output", auditOutputSummary(output)),
            },
            ...(call.error === undefined
                ? []
                : [formatField("Error", call.error)]),
        ],
        id: `audit-call:${call.callId}`,
        primaryRoute:
            key.kind === "unscoped"
                ? {
                      callId: call.callId,
                      page: "audit",
                      scope: "unscoped",
                      view: "call",
                  }
                : undefined,
        searchText: `${call.toolName} ${call.status} ${call.callId} ${call.workspace ?? ""}`,
        status: toolCallStatus(call),
        summaryLines: [
            compactSummary(
                ["status", call.status],
                ["workspace", workspaceFolderName(call.workspace)],
                ["duration", duration(call)],
            ),
        ],
        title: `${call.toolName} · ${workspaceFolderName(call.workspace)}`,
    });
}

function approvalBox(
    state: TuiAppState,
    instance: string,
    approval: ApprovalRequest,
): BoxModel {
    return makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Approval", approval.approvalId),
            formatField("Tool", approval.toolName),
            formatField("Risk", approval.riskLevel),
            formatField("Workspace", approval.workspace ?? "-"),
            formatField("Reason", approval.reason),
            {
                id: `approval.open:${approval.approvalId}`,
                text: "[ Review ]",
                tone: "accent",
            },
        ],
        id: `approval-${approval.approvalId}`,
        searchText: `status ${approval.status} risk ${approval.riskLevel} source ${approval.source} tool ${approval.toolName} ${approval.approvalId} ${approval.workspace ?? ""}`,
        severity: approval.riskLevel === "high" ? "danger" : "warning",
        status: approval.status === "pending" ? "pending" : "normal",
        summaryLines: [
            compactSummary(
                ["approval", approval.status],
                ["risk", approval.riskLevel],
                ["workspace", workspaceFolderName(approval.workspace)],
            ),
        ],
        title: `Approval · ${approval.toolName} · ${workspaceFolderName(approval.workspace)}`,
    });
}

function duration(call: ToolCallRecord): string {
    if (call.completedAt === undefined) return "running";
    const milliseconds =
        Date.parse(call.completedAt) - Date.parse(call.startedAt);
    return Number.isFinite(milliseconds) && milliseconds >= 0
        ? `${milliseconds}ms`
        : "-";
}
