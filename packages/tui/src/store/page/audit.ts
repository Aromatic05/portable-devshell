import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { buildSelectedInstancePageContext, compactSummary, formatField, makeBox, toolCallStatus } from "./PageBoxSupport.js";

export function buildAuditPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { approvals, toolCalls } = buildSelectedInstancePageContext(state, instanceName);

    const auditBoxes = (toolCalls.length === 0 ? [undefined] : toolCalls).map((record, index) =>
        makeBox(state, "audit", instanceName, {
            detailLines:
                record === undefined
                    ? ["No tool call history from instance.readToolCalls or stream events.", ...approvalLines(approvals)]
                    : [
                          `callId ${record.callId}`,
                          `tool ${record.toolName}`,
                          `status ${record.status}`,
                          `startedAt ${record.startedAt}`,
                          `completedAt ${record.completedAt ?? "-"}`,
                          `source ${record.source}`,
                          `input ${record.inputSummary || "-"}`,
                          ...approvalLines([
                              ...approvals.filter((approval) => approval.callId === record.callId),
                              ...(index === 0 ? approvals.filter((approval) => !toolCalls.some((toolCall) => toolCall.callId === approval.callId)) : [])
                          ])
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

    return auditBoxes;
}

function approvalLines(approvals: ReturnType<typeof buildSelectedInstancePageContext>["approvals"]): Array<string | { id: string; text: string; tone: "accent" }> {
    return approvals.flatMap((approval) => [
        "Pending approval:",
        formatField("Approval", approval.approvalId),
        formatField("Tool", approval.toolName),
        formatField("Risk", approval.riskLevel),
        formatField("Reason", approval.reason),
        formatField("Input", approval.inputSummary),
        { id: `approval.open:${approval.approvalId}`, text: "Enter approval review", tone: "accent" }
    ]);
}
