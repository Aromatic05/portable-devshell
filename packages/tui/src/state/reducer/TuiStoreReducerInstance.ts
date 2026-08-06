import { applyEventRecord } from "./TuiStoreReducerEvent.js";
import { withDerivedState } from "./TuiStoreReducerSupport.js";
import type { TuiAppAction, TuiAppState } from "./TuiStoreModel.js";

export function reduceTuiStoreReducerInstance(
    state: TuiAppState,
    action: TuiAppAction,
): TuiAppState | undefined {
    switch (action.type) {
        case "log.clearBuffer":
            return withDerivedState({ ...state, logsByInstance: {} });
        case "event.append": {
            const rawEvents = [...state.rawEvents, action.rawEvent];
            const maxEvents = action.maxEvents ?? 100;
            const nextState = {
                ...state,
                lastSeqByInstance:
                    (state.lastSeqByInstance[action.rawEvent.instance] ?? 0) >= action.rawEvent.seq
                        ? state.lastSeqByInstance
                        : {
                              ...state.lastSeqByInstance,
                              [action.rawEvent.instance]: action.rawEvent.seq,
                          },
                rawEvents: rawEvents.slice(Math.max(0, rawEvents.length - maxEvents)),
            };
            return withDerivedState(applyEventRecord(nextState, action.rawEvent));
        }
    }
}
