import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import type { TuiAuditContextKey } from "./TuiAuditContextProjection.js";
import {
    auditInputSummary,
    auditOutputSummary,
} from "../../../state/audit/TuiAuditPresentation.js";
import { formatField, makeBox, toolCallStatus } from "../TuiPageBoxSupport.js";

export function buildAuditCallBoxes(
    state: TuiAppState,
    instance: string,
    key: TuiAuditContextKey,
    callId: string,
): BoxModel[] {
    const call = (state.toolCallsByInstance[instance] ?? []).find(
        (candidate) =>
            candidate.callId === callId &&
            (key.kind === "unscoped"
                ? candidate.ctxId === undefined || candidate.ctxId.length === 0
                : candidate.ctxId === key.ctxId),
    );
    if (call === undefined) return [];
    return [
        makeBox(state, "audit", instance, {
            detailLines: [
                formatField(
                    "Context",
                    key.kind === "unscoped" ? "unscoped" : key.ctxId,
                ),
                formatField("Call", call.callId),
                formatField("Tool", call.toolName),
                formatField("Status", call.status),
                formatField("Source", call.source),
                formatField("Request", call.requestId ?? "-"),
                formatField("Task", call.taskId ?? "-"),
                formatField("Todo item", call.todoItemId ?? "-"),
                `input ${auditInputSummary(call.input, call.inputSummary)}`,
                `result ${auditOutputSummary(call.output)}`,
                ...(call.error === undefined
                    ? []
                    : [formatField("Error", call.error)]),
            ],
            id: `audit-call-detail:${call.callId}`,
            status: toolCallStatus(call),
            summaryLines: [
                `${call.startedAt} → ${call.completedAt ?? "running"}`,
            ],
            title: `${call.toolName} · ${call.callId}`,
        }),
    ];
}
