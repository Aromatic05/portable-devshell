import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState, TuiLogEntry } from "../../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../../state/route/TuiRouteState.js";
import { buildLogSourceBoxes } from "./logs/TuiPageLogSources.js";
import { buildLogStreamBoxes, filterLogEntries } from "./logs/TuiPageLogStream.js";

export { filterLogEntries };

export function buildLogsPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const route = currentTuiRoute(state);
    if (route.page !== "logs") return [];
    return route.view === "sources"
        ? buildLogSourceBoxes(state, instanceName)
        : buildLogStreamBoxes(state, instanceName, route.sourceId);
}

export type { TuiLogEntry };
