import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";
import { projectAuditContexts } from "./TuiAuditContextProjection.js";

export function buildAuditContextListBoxes(
    state: TuiAppState,
    instance: string,
): BoxModel[] {
    const contexts = projectAuditContexts(state, instance);
    if (contexts.length === 0) {
        return [
            makeBox(state, "audit", instance, {
                detailLines: ["No context-scoped audit records are available."],
                expandable: false,
                id: "audit-contexts-empty",
                status: "normal",
                summaryLines: ["contexts=0"],
                title: "Audit Contexts",
            }),
        ];
    }

    return contexts.map((context) =>
        makeBox(state, "audit", instance, {
            detailLines: [
                formatField("Context", context.label),
                formatField("Calls", String(context.calls.length)),
                formatField("Approvals", String(context.approvals.length)),
                formatField("Latest", context.latestActivityAt),
                formatField("Latest call", context.latestCall?.toolName ?? "-"),
            ],
            id:
                context.key.kind === "unscoped"
                    ? "audit-scope:unscoped"
                    : `audit-context:${context.key.ctxId}`,
            primaryRoute:
                context.key.kind === "unscoped"
                    ? { page: "audit", scope: "unscoped", view: "context" }
                    : {
                          ctxId: context.key.ctxId,
                          page: "audit",
                          scope: "context",
                          view: "context",
                      },
            searchText: [
                context.label,
                ...context.calls.flatMap((call) => [
                    `status ${call.status}`,
                    `source ${call.source}`,
                    `tool ${call.toolName}`,
                    call.callId,
                ]),
                ...context.approvals.flatMap((approval) => [
                    `status ${approval.status}`,
                    `risk ${approval.riskLevel}`,
                    `source ${approval.source}`,
                    `tool ${approval.toolName}`,
                    approval.approvalId,
                ]),
            ].join(" "),
            status: context.status,
            summaryLines: [
                compactSummary(
                    ["calls", String(context.calls.length)],
                    ["latest", context.latestCall?.toolName ?? "-"],
                ),
                context.latestActivityAt,
            ],
            title: context.label,
        }),
    );
}
