import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { buildSelectedInstancePageContext, compactSummary, formatField, makeBox, renderApprovalLine, toolCallStatus } from "./PageBoxSupport.js";

export function buildAuditPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { approvals, toolCalls } = buildSelectedInstancePageContext(state, instanceName);

    const auditBoxes = (toolCalls.length === 0 ? [undefined] : toolCalls).map((record, index) =>
        makeBox(state, "audit", instanceName, {
            detailLines:
                record === undefined
                    ? ["No tool call history from instance.readToolCalls or stream events."]
                    : [
                          `callId ${record.callId}`,
                          `tool ${record.toolName}`,
                          `status ${record.status}`,
                          `startedAt ${record.startedAt}`,
                          `completedAt ${record.completedAt ?? "-"}`,
                          `source ${record.source}`,
                          `input ${record.inputSummary || "-"}`,
                          { id: `tool.action:${record.toolName}`, text: "Open tool action form." }
                      ],
            id: record === undefined ? "audit-empty" : `audit-${record.callId}`,
            status: record === undefined ? "normal" : toolCallStatus(record),
            summaryLines: [
                record === undefined
                    ? compactSummary(["records", "0"], ["last", "-"], ["tool", "-"])
                    : compactSummary(["status", record.status], ["tool", record.toolName], ["source", record.source])
            ],
            title: record === undefined ? "Audit" : `Audit ${index + 1}`
        })
    );

    return [
        ...auditBoxes,
        ...approvals.map((approval) =>
            makeBox(state, "audit", instanceName, {
                detailLines: [
                    formatField("Approval", approval.approvalId),
                    formatField("Tool", approval.toolName),
                    formatField("Risk", approval.riskLevel),
                    formatField("Reason", approval.reason),
                    formatField("Input", approval.inputSummary),
                    { id: `approval.action:${approval.approvalId}`, text: "Open approval actions." }
                ],
                id: `approval-${approval.approvalId}`,
                status: "pending",
                summaryLines: [renderApprovalLine(approval), "Enter opens detail; it never approves directly."],
                title: "Pending Approval"
            })
        )
    ];
}
