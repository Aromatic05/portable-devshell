import { applyEventRecord } from "./Event.js";
import { withDerivedState } from "../Support.js";
import type { TuiAppAction, TuiAppState } from "../../Model.js";

export function reduceTuiStoreReducerInstance(
    state: TuiAppState,
    action: TuiAppAction,
): TuiAppState | undefined {
    switch (action.type) {
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
