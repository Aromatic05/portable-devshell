import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";
import { projectAuditContexts } from "./TuiAuditContextProjection.js";

export function buildAuditContextListBoxes(state: TuiAppState, instance: string): BoxModel[] {
    const contexts = projectAuditContexts(state, instance);
    if (contexts.length === 0) {
        return [makeBox(state, "audit", instance, {
            detailLines: ["No context-scoped audit records are available."],
            expandable: false,
            id: "audit-contexts-empty",
            status: "normal",
            summaryLines: ["contexts=0"],
            title: "Audit Contexts"
        })];
    }

    return contexts.map((context) => makeBox(state, "audit", instance, {
        detailLines: [
            formatField("Context", context.ctxId),
            formatField("Calls", String(context.calls.length)),
            formatField("Approvals", String(context.approvals.length)),
            formatField("Latest", context.latestActivityAt),
            formatField("Latest call", context.latestCall?.toolName ?? "-")
        ],
        id: `audit-context:${context.ctxId}`,
        primaryRoute: { ctxId: context.ctxId, page: "audit", view: "context" },
        searchText: `${context.ctxId} ${context.latestCall?.toolName ?? ""}`,
        status: context.status,
        summaryLines: [
            compactSummary(["calls", String(context.calls.length)], ["messages", String(context.messages.length)], ["latest", context.latestCall?.toolName ?? "-"]),
            context.latestActivityAt
        ],
        title: context.ctxId
    }));
}
