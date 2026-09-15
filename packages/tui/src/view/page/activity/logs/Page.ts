import type { BoxModel } from "../../../component/content/Box.js";
import type {
    TuiAppState,
    TuiLogEntry,
} from "../../../../state/store/Model.js";
import { currentTuiRoute } from "../../../../state/route/State.js";
import { buildLogContextListBoxes } from "./Sources.js";
import {
    buildLogContextBoxes,
    filterLogEntries,
} from "./Stream.js";

export { filterLogEntries };

export function buildLogsPageBoxes(
    state: TuiAppState,
    instanceName: string,
): BoxModel[] {
    const route = currentTuiRoute(state);
    if (route.page !== "logs") return [];
    return route.view === "contexts"
        ? buildLogContextListBoxes(state, instanceName)
        : buildLogContextBoxes(
              state,
              instanceName,
              route.scope === "unscoped"
                  ? { kind: "unscoped" }
                  : { ctxId: route.ctxId, kind: "context" },
          );
}

export type { TuiLogEntry };
