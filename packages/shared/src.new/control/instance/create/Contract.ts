// Instance-management wire contract. These are Control-plane operations that
// create and enable/disable instances; runtime lifecycle is a separate domain.
//
// `list` returns a revision-bearing envelope and `subscribe` is a
// cursor-resumable change feed over the same revision space: subscribers
// resume at `revision + 1` from the list envelope and receive replay plus live
// change events, or an explicit stream gap when the revision has aged out.

import {
    readStreamGap,
    readStreamGapPayload,
    STREAM_GAP_CODE,
    type EventStreamEnvelope,
    type EventStreamPort,
    type StreamGap,
} from "../../../transport/stream/EventStream.js";
import type { JsonValue } from "../../../transport/primitive/JsonValue.js";
import type {
    InstanceChangeEvent,
    InstanceCreateDraft,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    InstanceListEnvelope,
} from "./Model.js";

export const instanceOperations = {
    create: "create",
    createSchema: "createSchema",
    delete: "delete",
    disable: "disable",
    enable: "enable",
    list: "list",
    snapshot: "snapshot",
    subscribe: "subscribe",
    validateCreate: "validateCreate",
} as const;

export interface InstanceContract {
    create: {
        request: InstanceCreateDraft;
        response: InstanceCreateResult;
    };
    createSchema: {
        request: undefined;
        response: InstanceCreateSchema;
    };
    delete: {
        request: { instanceName: string };
        response: Record<string, JsonValue>;
    };
    disable: {
        request: { instanceName: string };
        response: Record<string, JsonValue>;
    };
    enable: {
        request: { instanceName: string };
        response: Record<string, JsonValue>;
    };
    list: {
        request: undefined;
        response: InstanceListEnvelope["instances"];
    };
    snapshot: {
        request: undefined;
        response: InstanceListEnvelope;
    };
    validateCreate: {
        request: InstanceCreateDraft;
        response: InstanceCreateSummary;
    };
}

export type InstanceOperation = keyof InstanceContract;

export type InstanceRequest<Operation extends InstanceOperation> =
    InstanceContract[Operation]["request"];

export type InstanceResponse<Operation extends InstanceOperation> =
    InstanceContract[Operation]["response"];

export interface InstanceChangeSubscribeRequest {
    fromRevision: number;
}

export const INSTANCE_CHANGE_STREAM_GAP_CODE = STREAM_GAP_CODE;

export type InstanceChangeStreamGap = StreamGap;

export type InstanceChangeStreamEnvelope = EventStreamEnvelope;

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
