import { applyEventRecord } from "./Event.js";
import { withDerivedState } from "../Support.js";
import type { TuiAppAction, TuiAppState } from "../../Model.js";

export function reduceTuiStoreReducerInstance(
    state: TuiAppState,
    action: TuiAppAction,
): TuiAppState | undefined {
    switch (action.type) {
        case "log.clearBuffer": {
            const instance = state.ui.selectedInstance;
            if (instance === undefined) return state;
            const throughSeq =
                state.readModel.instanceState[instance]?.logs.at(-1)?.seq ?? 0;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    logsClearedThroughSeqByInstance: {
                        ...state.ui.logsClearedThroughSeqByInstance,
                        [instance]: throughSeq,
                    },
                },
            };
        }
        case "event.append": {
            const rawEvents = [...state.rawEvents, action.rawEvent];
            const maxEvents = action.maxEvents ?? 100;
            const nextState = {
                ...state,
                rawEvents: rawEvents.slice(
                    Math.max(0, rawEvents.length - maxEvents),
                ),
            };
            return withDerivedState(
                applyEventRecord(nextState, action.rawEvent),
            );
        }
    }
}
