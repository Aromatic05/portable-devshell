import { reduceTuiStoreReducerArtifact } from "./TuiStoreReducerArtifact.js";
import { reduceTuiStoreReducerControl } from "./TuiStoreReducerControl.js";
import { reduceTuiStoreReducerInstance } from "./TuiStoreReducerInstance.js";
import { reduceTuiStoreReducerInteraction } from "./TuiStoreReducerInteraction.js";
import type { TuiAppAction, TuiAppState } from "./TuiStoreModel.js";

export function tuiAppReducer(state: TuiAppState, action: TuiAppAction): TuiAppState {
    return (
        reduceTuiStoreReducerArtifact(state, action) ??
        reduceTuiStoreReducerControl(state, action) ??
        reduceTuiStoreReducerInteraction(state, action) ??
        reduceTuiStoreReducerInstance(state, action) ??
        state
    );
}
