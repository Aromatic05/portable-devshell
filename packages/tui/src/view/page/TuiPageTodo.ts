import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../../state/route/TuiRouteState.js";
import { buildTodoDetailBoxes } from "./todo/TuiPageTodoDetail.js";
import { buildTodoOverviewBoxes } from "./todo/TuiPageTodoOverview.js";

export function buildTodoPageBoxes(state: TuiAppState, instanceName: string): BoxModel[] {
    const route = currentTuiRoute(state);
    if (route.page !== "todo") return [];
    return route.view === "overview"
        ? buildTodoOverviewBoxes(state, instanceName)
        : buildTodoDetailBoxes(state, instanceName, route.todoId);
}
