import { reconcileTuiRouteResources } from "../../route/State.js";
import { reduceTuiStoreReducerControl } from "./data/Control.js";
import { reduceTuiStoreReducerInstance } from "./data/Instance.js";
import { reduceTuiStoreReducerInteraction } from "./ui/Interaction.js";
import { reduceTuiStoreReducerOverlay } from "./ui/Overlay.js";
import { reduceTuiStoreReducerRoute } from "./ui/Route.js";
import type { TuiAppAction, TuiAppState } from "../Model.js";

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
