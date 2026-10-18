import type { TuiAppState } from "../../../../../state/store/Model.js";
import { workspaceFolderName } from "../../../../presentation/Workspace.js";
import { currentTuiRoute } from "../../../../../state/route/State.js";
import type { TuiSidebarContextEntry } from "../../../../../state/Ui.js";
import type { TuiDomainReader } from "../../../../../app/control/Reader.js";
import { projectAuditContexts } from "../../../../../state/route/Audit.js";

export function selectTuiAuditSidebarEntries(
    state: TuiAppState,
    reader: TuiDomainReader,
    focused: boolean,
    cursor: TuiAppState["interaction"]["sidebarCursor"],
): TuiSidebarContextEntry[] {
    const route = currentTuiRoute(state);
    const instance = state.ui.selectedInstance;
    const contexts =
        instance === undefined ? [] : projectAuditContexts(reader, instance);
    const baseLabels = contexts.map((context) =>
        context.workspace === undefined
            ? context.label
            : workspaceFolderName(context.workspace),
    );
    const labelCounts = new Map<string, number>();
    for (const label of baseLabels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }

    const entries = contexts.map((context, index): TuiSidebarContextEntry => {
        const baseLabel = baseLabels[index] ?? context.label;
        const label =
            (labelCounts.get(baseLabel) ?? 0) > 1 &&
            context.key.kind === "context"
                ? `${baseLabel} · ${compactContextId(context.key.ctxId)}`
                : baseLabel;
        const id =
            context.key.kind === "unscoped"
                ? "audit:unscoped"
                : `audit:context:${context.key.ctxId}`;
        const selected =
            route.page === "audit" &&
            route.view !== "contexts" &&
            (context.key.kind === "unscoped"
                ? route.scope === "unscoped"
                : route.scope === "context" &&
                  route.ctxId === context.key.ctxId);
        return {
            focused: focused && cursor?.kind === "context" && cursor.id === id,
            id,
            label,
            selected,
            target:
                context.key.kind === "unscoped"
                    ? {
                          kind: "route",
                          route: {
                              page: "audit",
                              scope: "unscoped",
                              view: "context",
                          },
                      }
                    : {
                          kind: "route",
                          route: {
                              ctxId: context.key.ctxId,
                              page: "audit",
                              scope: "context",
                              view: "context",
                          },
                      },
        };
    });

    return [
        {
            focused:
                focused &&
                cursor?.kind === "context" &&
                cursor.id === "audit:back",
            id: "audit:back",
            label: "← audit",
            selected: route.page === "audit" && route.view === "contexts",
            target: { kind: "root" },
        },
        ...entries,
    ];
}

function compactContextId(ctxId: string): string {
    return ctxId.length <= 12 ? ctxId : `${ctxId.slice(0, 8)}…`;
}
