import type { TuiAppState } from "../reducer/TuiStoreModel.js";
import type { TuiOverlay } from "./TuiOverlay.js";

export function pushTuiOverlay(state: TuiAppState, overlay: TuiOverlay): TuiAppState {
    return {
        ...state,
        interaction: {
            ...state.interaction,
            overlays: [...state.interaction.overlays, overlay]
        }
    };
}

export function replaceTopTuiOverlay(state: TuiAppState, overlay: TuiOverlay): TuiAppState {
    if (state.interaction.overlays.length === 0) return pushTuiOverlay(state, overlay);
    return {
        ...state,
        interaction: {
            ...state.interaction,
            overlays: [...state.interaction.overlays.slice(0, -1), overlay]
        }
    };
}

export function popTuiOverlay(state: TuiAppState): TuiAppState {
    if (state.interaction.overlays.length === 0) return state;
    return {
        ...state,
        interaction: {
            ...state.interaction,
            overlays: state.interaction.overlays.slice(0, -1)
        }
    };
}
