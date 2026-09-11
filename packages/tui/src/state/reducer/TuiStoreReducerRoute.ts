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
        case "ui.selectPage": {
            const sidebarLevel =
                action.page === "audit" || action.page === "messages"
                    ? "section"
                    : "root";
            if (state.ui.selectedPage === action.page) {
                if (state.ui.sidebarLevel === sidebarLevel) return state;
                return {
                    ...state,
                    ui: { ...state.ui, sidebarLevel },
                };
            }
            const next = transitionTuiRouteContext(state, action.page, state.ui.selectedInstance);
            return {
                ...next,
                ui: {
                    ...next.ui,
                    sidebarLevel,
                },
            };
        }
        case "ui.selectInstance":
            if (state.ui.selectedInstance === action.instance) return state;
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
