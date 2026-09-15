import { workspaceFolderName } from "@portable-devshell/shared";
import { type BoxModel } from "../../../component/content/Box.js";
import { type TuiAppState } from "../../../../state/store/Model.js";
import { compactSummary, formatField, makeBox } from "../../Support.js";
import { projectAuditContexts } from "./projection/Context.js";
import { currentTuiRoute } from "../../../../state/route/State.js";
import { buildAuditContextBoxes } from "./Context.js";
import { buildAuditConversationBoxes } from "./Conversation.js";

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
                formatField("Workspace", context.workspace ?? "-"),
                formatField("Context", context.label),
                formatField("Calls", String(context.calls.length)),
                formatField("Approvals", String(context.approvals.length)),
                formatField("Latest", context.latestActivityAt),
                formatField("Latest call", context.latestCall?.toolName ?? "-"),
                ...(context.contextStatus === undefined
                    ? []
                    : [formatField("Status", context.contextStatus)]),
                ...(context.key.kind === "unscoped" ||
                context.contextStatus === "disabled"
                    ? []
                    : [
                          {
                              id: "context.disable",
                              text: "[ Disable ]",
                              tone: "accent" as const,
                          },
                          {
                              id: "context.renew",
                              text: "[ Renew ]",
                              tone: "accent" as const,
                          },
                      ]),
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
                `workspace ${context.workspace ?? ""}`,
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
            title:
                context.workspace === undefined
                    ? context.label
                    : workspaceFolderName(context.workspace),
        }),
    );
}

export function buildAuditPageBoxes(
    state: TuiAppState,
    instanceName: string,
): BoxModel[] {
    const route = currentTuiRoute(state);
    if (route.page !== "audit") return [];
    if (route.view === "contexts")
        return buildAuditContextListBoxes(state, instanceName);
    if (route.view === "conversation") {
        return buildAuditConversationBoxes(state, instanceName, route.ctxId);
    }
    const key =
        route.scope === "unscoped"
            ? { kind: "unscoped" as const }
            : { ctxId: route.ctxId, kind: "context" as const };
    return buildAuditContextBoxes(state, instanceName, key);
}
