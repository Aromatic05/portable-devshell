// Instance event-stream contract. The stream protocol is shared by every
// instance-scoped subscription (runtime, todo, approval): an initial seed of
// buffered events, live events, and an explicit gap descriptor when the
// requested sequence has already fallen out of the server buffer. The generic
// sequence/cursor mechanics live in transport/stream.

import {
    readStreamGap,
    readStreamGapPayload,
    STREAM_GAP_CODE,
    type EventStreamEnvelope,
    type EventStreamPort,
    type StreamGap,
    type StreamMessage,
} from "../../transport/stream/EventStream.js";
import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type { InstanceEvent } from "./Model.js";

export const INSTANCE_STREAM_GAP_CODE = STREAM_GAP_CODE;

export type InstanceStreamGap = StreamGap;

export interface InstanceEventSubscribeRequest {
    fromSeq: number;
}

export type InstanceStreamEnvelope = EventStreamEnvelope;

export type InstanceStreamMessage = StreamMessage<InstanceEvent>;

export type InstanceEventStreamPort = EventStreamPort<InstanceEvent>;

/**
 * Anything that can open the instance-wide, cursor-resumable event stream.
 * RuntimeTransport satisfies this; domains without a server-filtered stream
 * (approval) consume the shared stream and filter events client-side so the
 * subscription cursor still tracks the global instance sequence.
 */
export interface InstanceEventSource {
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort>;
}

export const readInstanceStreamGap = readStreamGap;
export const readInstanceStreamGapPayload = readStreamGapPayload;

export function readInstanceEvent(value: JsonValue | undefined): InstanceEvent {
    const event = record(value);
    if (
        event === undefined ||
        typeof event.at !== "string" ||
        typeof event.instanceName !== "string" ||
        typeof event.seq !== "number" ||
        typeof event.type !== "string"
    )
        throw new Error("Invalid instance event.");
    return {
        at: event.at,
        ...(event.data === undefined ? {} : { data: event.data }),
        instanceName: event.instanceName as InstanceEvent["instanceName"],
        seq: event.seq,
        type: event.type as InstanceEvent["type"],
    };
}

function record(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
