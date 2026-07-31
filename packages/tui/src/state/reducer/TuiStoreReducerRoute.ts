import {
    popTuiRoute,
    pushTuiRoute,
    replaceTuiRoute,
    resetTuiRoute,
    transitionTuiRouteContext
} from "../route/TuiRouteState.js";
import type { TuiAppAction, TuiAppState } from "./TuiStoreModel.js";

export function reduceTuiStoreReducerRoute(state: TuiAppState, action: TuiAppAction): TuiAppState | undefined {
    switch (action.type) {
        case "ui.selectPage":
            return transitionTuiRouteContext(state, action.page, state.ui.selectedInstance);
        case "ui.selectInstance":
            return transitionTuiRouteContext(state, state.ui.selectedPage, action.instance);
        case "route.push":
            return pushTuiRoute(state, action.route);
        case "route.pop":
            return popTuiRoute(state);
        case "route.replace":
            return replaceTuiRoute(state, action.route);
        case "route.reset":
            return resetTuiRoute(state);
    }
}
