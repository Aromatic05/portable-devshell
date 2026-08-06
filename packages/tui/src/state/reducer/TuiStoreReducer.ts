import { reconcileTuiRouteResources } from "../route/TuiRouteState.js";
import { reduceTuiStoreReducerControl } from "./TuiStoreReducerControl.js";
import { reduceTuiStoreReducerInstance } from "./TuiStoreReducerInstance.js";
import { reduceTuiStoreReducerInteraction } from "./TuiStoreReducerInteraction.js";
import { reduceTuiStoreReducerOverlay } from "./TuiStoreReducerOverlay.js";
import { reduceTuiStoreReducerRoute } from "./TuiStoreReducerRoute.js";
import type { TuiAppAction, TuiAppState } from "./TuiStoreModel.js";

export function tuiAppReducer(state: TuiAppState, action: TuiAppAction): TuiAppState {
    const nextState =
        reduceTuiStoreReducerControl(state, action) ??
        reduceTuiStoreReducerRoute(state, action) ??
        reduceTuiStoreReducerOverlay(state, action) ??
        reduceTuiStoreReducerInteraction(state, action) ??
        reduceTuiStoreReducerInstance(state, action) ??
        state;

    return reconcileTuiRouteResources(nextState);
}
