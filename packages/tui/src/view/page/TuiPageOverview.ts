import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import { makeBox } from "./TuiPageBoxSupport.js";
import { buildOverviewActivityBoxes } from "./TuiPageOverviewActivity.js";
import { buildOverviewInstanceBoxes } from "./TuiPageOverviewInstances.js";
import {
    buildOverviewAlertBoxes,
    buildOverviewHealthBox
} from "./TuiPageOverviewSummary.js";
import { buildOverviewTodoBoxes } from "./TuiPageOverviewTodos.js";
import { selectTuiOverviewPresentation } from "./TuiOverviewPresentation.js";

export function buildOverviewPageBoxes(state: TuiAppState): BoxModel[] {
    const overview = state.operationalOverview;
    if (overview === undefined) {
        return [makeBox(state, "overview", undefined, {
            detailLines: [
                "The connected control server does not provide overview.get.",
                "Reload after upgrading or reconnecting the control process."
            ],
            id: "overview-unavailable",
            status: "warning",
            summaryLines: ["Shared operational overview is unavailable."],
            title: "Operational Overview"
        })];
    }

    const presentation = selectTuiOverviewPresentation(overview);
    return [
        buildOverviewHealthBox(state, presentation),
        ...buildOverviewAlertBoxes(state, presentation.alerts),
        ...buildOverviewInstanceBoxes(state, presentation.instances),
        ...buildOverviewActivityBoxes(state, presentation.activity),
        ...buildOverviewTodoBoxes(state, presentation.todos)
    ];
}
