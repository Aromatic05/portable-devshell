import type { ApprovalRequest } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { buildSelectedInstancePageContext, compactSummary, formatField, makeBox, toolCallStatus } from "./PageBoxSupport.js";
import { auditInputSummary, auditOutputSummary, resolveAuditCtxId, resolveAuditOutput } from "./AuditInputPresentation.js";

export function buildAuditPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { approvals, logs, toolCalls } = buildSelectedInstancePageContext(state, instanceName);
    const pending = approvals.map((approval, index) => approvalBox(state, instanceName, approval, index));
    const history = toolCalls.length === 0
        ? [makeBox(state, "audit", instanceName, {
              detailLines: ["No tool call history."],
              id: "audit-empty",
              status: "normal",
              summaryLines: [compactSummary(["records", "0"])],
              title: "Tool Call History"
          })]
        : toolCalls.map((record) => {
              const output = resolveAuditOutput(record.output, logs, record.callId);
              const ctxId = resolveAuditCtxId(record.ctxId, logs, record.callId);
              return makeBox(state, "audit", instanceName, {
                  detailLines: [
                      `callId ${record.callId}`,
                      `tool ${record.toolName}`,
                      `status ${record.status}`,
                      `startedAt ${record.startedAt}`,
                      `completedAt ${record.completedAt ?? "-"}`,
                      `source ${record.source}`,
                      `ctxId ${ctxId ?? "-"}`,
                      `task ${record.taskId ?? "-"}`,
                      `todo item ${record.todoItemId ?? "-"}`,
                      { id: "input", text: `input ${auditInputSummary(record.input, record.inputSummary)}` },
                      { id: "output", text: `output ${auditOutputSummary(output)}` }
                  ],
                  id: `audit-${record.callId}`,
                  status: toolCallStatus(record),
                  summaryLines: [compactSummary(["status", record.status], ["source", record.source], ["time", record.startedAt])],
                  title: `${record.toolName} · ${record.status}`
              });
          });

    return [...pending, ...history];
}

function approvalBox(state: TuiAppState, instanceName: string, approval: ApprovalRequest, index: number): BoxModel {
    return makeBox(state, "audit", instanceName, {
        detailLines: [
            formatField("Approval", approval.approvalId),
            formatField("Tool", approval.toolName),
            formatField("Risk", approval.riskLevel),
            formatField("Source", approval.source),
            formatField("ctxId", approval.ctxId ?? "-"),
            formatField("Reason", approval.reason),
            formatField("Input", approval.inputSummary),
            { id: `approval.open:${approval.approvalId}`, text: "[ Review ]", tone: "accent" }
        ],
        id: `approval-${approval.approvalId}`,
        severity: approval.riskLevel === "high" ? "danger" : approval.riskLevel === "medium" ? "warning" : "accent",
        status: "pending",
        summaryLines: [compactSummary(["risk", approval.riskLevel], ["tool", approval.toolName], ["source", approval.source])],
        title: `Pending Approval ${index + 1} · ${approval.toolName}`
    });
}
