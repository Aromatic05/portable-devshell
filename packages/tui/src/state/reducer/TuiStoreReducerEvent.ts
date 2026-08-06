import type { TuiAppState, TuiRawEventRecord } from "./TuiStoreModel.js";

export function applyEventRecord(
    state: TuiAppState,
    event: TuiRawEventRecord,
): TuiAppState {
    const payload = event.payload;
    if (
        isStatusEvent(event.event) &&
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        typeof payload.at === "string"
    ) {
        return {
            ...state,
            lastStatusChangeAtByInstance: {
                ...state.lastStatusChangeAtByInstance,
                [event.instance]: payload.at,
            },
        };
    }
    return state;
}

function isStatusEvent(type: string): boolean {
    return type.startsWith("instance.") ||
        type.startsWith("worker.") ||
        type.startsWith("reverse.");
}
