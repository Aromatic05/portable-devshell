import {
    type EventStreamPort,
    readStreamGap,
    readStreamGapPayload,
} from "../../client/Stream.js";
import type { JsonValue } from "../../types/Json.js";
import type { InstanceChangeEvent } from "./Model.js";

export type InstanceChangeStreamPort = EventStreamPort<InstanceChangeEvent>;
export const readInstanceChangeStreamGap = readStreamGap;
export const readInstanceChangeStreamGapPayload = readStreamGapPayload;
export function readInstanceChangeEvent(
    value: JsonValue | undefined,
): InstanceChangeEvent {
    const event = record(value);
    if (
        event === undefined ||
        (event.kind !== "config" && event.kind !== "registry") ||
        typeof event.revision !== "number"
    )
        throw new Error("Invalid instance change event.");
    return { kind: event.kind, revision: event.revision };
}
function record(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
