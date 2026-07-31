import { popTuiOverlay, pushTuiOverlay, replaceTopTuiOverlay } from "../overlay/TuiOverlayState.js";
import type { TuiAppAction, TuiAppState } from "./TuiStoreModel.js";

export function reduceTuiStoreReducerOverlay(state: TuiAppState, action: TuiAppAction): TuiAppState | undefined {
    switch (action.type) {
        case "overlay.push":
            return pushTuiOverlay(state, action.overlay);
        case "overlay.replaceTop":
            return replaceTopTuiOverlay(state, action.overlay);
        case "overlay.pop":
            return popTuiOverlay(state);
    }
}
