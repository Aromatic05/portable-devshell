import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../../state/route/TuiRouteState.js";
import { buildAuditCallBoxes } from "./audit/TuiPageAuditCall.js";
import { buildAuditContextBoxes } from "./audit/TuiPageAuditContext.js";
import { buildAuditContextListBoxes } from "./audit/TuiPageAuditContexts.js";

export function buildAuditPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const route = currentTuiRoute(state);
    if (route.page !== "audit") return [];
    if (route.view === "contexts") return buildAuditContextListBoxes(state, instanceName);
    if (route.view === "context") return buildAuditContextBoxes(state, instanceName, route.ctxId);
    return buildAuditCallBoxes(state, instanceName, route.ctxId, route.callId);
}
