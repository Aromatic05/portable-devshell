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
            if (state.ui.selectedPage === action.page) return state;
            const next = transitionTuiRouteContext(state, action.page, state.ui.selectedInstance);
            return {
                ...next,
                ui: {
                    ...next.ui,
                    sidebarLevel:
                        action.page === "audit" || action.page === "messages"
                            ? "section"
                            : "root",
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
