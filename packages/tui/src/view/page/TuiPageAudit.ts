import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../../state/route/TuiRouteState.js";
import { buildAuditContextBoxes } from "./audit/TuiPageAuditContext.js";
import { buildAuditContextListBoxes } from "./audit/TuiPageAuditContexts.js";
import { buildAuditConversationBoxes } from "./audit/TuiPageAuditConversation.js";

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
    const key = route.scope === "unscoped"
        ? { kind: "unscoped" as const }
        : { ctxId: route.ctxId, kind: "context" as const };
    return buildAuditContextBoxes(state, instanceName, key);
}
