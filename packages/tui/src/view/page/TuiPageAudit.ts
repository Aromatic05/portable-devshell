import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../../state/route/TuiRouteState.js";
import { buildAuditCallBoxes } from "./audit/TuiPageAuditCall.js";
import { buildAuditContextBoxes } from "./audit/TuiPageAuditContext.js";
import { buildAuditContextListBoxes } from "./audit/TuiPageAuditContexts.js";

export function buildAuditPageBoxes(
    state: TuiAppState,
    instanceName: string,
): BoxModel[] {
    const route = currentTuiRoute(state);
    if (route.page !== "audit") return [];
    if (route.view === "contexts")
        return buildAuditContextListBoxes(state, instanceName);
    const key =
        route.scope === "unscoped"
            ? { kind: "unscoped" as const }
            : { ctxId: route.ctxId, kind: "context" as const };
    if (route.view === "context") {
        return buildAuditContextBoxes(state, instanceName, key);
    }
    return buildAuditCallBoxes(state, instanceName, key, route.callId);
}
