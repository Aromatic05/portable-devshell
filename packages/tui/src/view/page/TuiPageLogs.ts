import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState, TuiLogEntry } from "../../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../../state/route/TuiRouteState.js";
import { buildLogContextListBoxes } from "./logs/TuiPageLogSources.js";
import { buildLogContextBoxes, filterLogEntries } from "./logs/TuiPageLogStream.js";

export { filterLogEntries };

export function buildLogsPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const route = currentTuiRoute(state);
    if (route.page !== "logs") return [];
    return route.view === "contexts"
        ? buildLogContextListBoxes(state, instanceName)
        : buildLogContextBoxes(state, instanceName, route.ctxId);
}

export type { TuiLogEntry };
