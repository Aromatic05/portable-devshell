import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../../state/route/TuiRouteState.js";
import { buildConnectionsOverviewBoxes } from "./connections/TuiPageConnectionsOverview.js";
import { buildReverseConnectionBoxes } from "./connections/TuiPageReverseConnection.js";
import { buildConnectorPageBoxes } from "./TuiPageConnector.js";
import { buildOAuthPageBoxes } from "./TuiPageOAuth.js";

export function buildConnectionsPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const route = currentTuiRoute(state);
    if (route.page !== "connections") return [];
    switch (route.view) {
        case "overview":
            return buildConnectionsOverviewBoxes(state, instanceName);
        case "connector":
            return buildConnectorPageBoxes(state, instanceName);
        case "oauth":
            return buildOAuthPageBoxes(state, instanceName);
        case "reverse":
            return buildReverseConnectionBoxes(state, instanceName, route.instanceId);
    }
}
