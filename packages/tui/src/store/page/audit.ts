import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { buildSelectedInstancePageContext, compactSummary, makeBox, toolCallStatus } from "./PageBoxSupport.js";

export function buildAuditPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const { toolCalls } = buildSelectedInstancePageContext(state, instanceName);

    return (toolCalls.length === 0 ? [undefined] : toolCalls).map((record, index) =>
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
                          `input ${record.inputSummary || "-"}`
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
}
