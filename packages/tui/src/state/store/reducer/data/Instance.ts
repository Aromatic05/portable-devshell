import type { TuiAppAction, TuiAppState } from "../../Model.js";

export function reduceTuiStoreReducerInstance(
    state: TuiAppState,
    action: TuiAppAction,
): TuiAppState | undefined {
    switch (action.type) {
        case "event.append": {
            const rawEvents = [...state.rawEvents, action.rawEvent];
            const maxEvents = action.maxEvents ?? 100;
            return {
                ...state,
                rawEvents: rawEvents.slice(
                    Math.max(0, rawEvents.length - maxEvents),
                ),
            };
        }
    }
}