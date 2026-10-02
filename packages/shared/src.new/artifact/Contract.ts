// Artifact wire contract shared by the Control artifact port and its clients.
// The transport in ./Transport.ts is typed against this map, so an operation
// cannot be called with a mismatched request or response shape. `subscribe` is
// a dedicated artifact event stream (new server work) rather than a projection
// over some other domain's stream.

import {
    readStreamGap,
    readStreamGapPayload,
    STREAM_GAP_CODE,
    type EventStreamPort,
    type StreamGap,
    type StreamMessage,
} from "../transport/stream/EventStream.js";
import type { JsonValue } from "../transport/primitive/JsonValue.js";
import type {
    ArtifactEvent,
    ArtifactEventType,
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactStoredImageResult,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
} from "./Model.js";

export const artifactOperations = {
    cancelTransfer: "cancelTransfer",
    createShare: "createShare",
    getTransfer: "getTransfer",
    listShares: "listShares",
    listTransfers: "listTransfers",
    readImage: "readImage",
    revokeShare: "revokeShare",
    startTransfer: "startTransfer",
    subscribe: "subscribe",
    viewImage: "viewImage",
} as const;

export interface ArtifactContract {
    cancelTransfer: {
        request: { transferId: string };
        response: ArtifactTransferResult;
    };
    createShare: {
        request: ArtifactShareInput & { defaultInstance: string };
        response: ArtifactShareResult;
    };
    getTransfer: {
        request: { transferId: string };
        response: ArtifactTransferRecord;
    };
    listShares: {
        request: undefined;
        response: ArtifactShareResult[];
    };
    listTransfers: {
        request: undefined;
        response: ArtifactTransferRecord[];
    };
    readImage: {
        request: { imageRef: string };
        response: ArtifactStoredImageResult;
    };
    revokeShare: {
        request: { shareId: string };
        response: ArtifactShareRevokeResult;
    };
    startTransfer: {
        request: ArtifactTransferStartInput & { defaultInstance: string };
        response: ArtifactTransferResult;
    };
    viewImage: {
        request: ArtifactViewImageInput & { defaultInstance: string };
        response: ArtifactViewImageResult;
    };
}

export type ArtifactOperation = keyof ArtifactContract;

export type ArtifactRequest<Operation extends ArtifactOperation> =
    ArtifactContract[Operation]["request"];

export type ArtifactResponse<Operation extends ArtifactOperation> =
    ArtifactContract[Operation]["response"];

export interface ArtifactSubscribeRequest {
    fromSeq: number;
}

export const ARTIFACT_STREAM_GAP_CODE = STREAM_GAP_CODE;

export type ArtifactStreamGap = StreamGap;

export type ArtifactStreamMessage = StreamMessage<ArtifactEvent>;

export type ArtifactEventStreamPort = EventStreamPort<ArtifactEvent>;

export const readArtifactStreamGap = readStreamGap;
export const readArtifactStreamGapPayload = readStreamGapPayload;

export function readArtifactEvent(value: JsonValue | undefined): ArtifactEvent {
    const event = record(value);
    if (
        event === undefined ||
        typeof event.at !== "string" ||
        typeof event.instance !== "string" ||
        typeof event.seq !== "number" ||
        typeof event.type !== "string"
    )
        throw new Error("Invalid artifact event.");
    return {
        at: event.at,
        ...(event.data === undefined ? {} : { data: event.data }),
        instance: event.instance,
        seq: event.seq,
        type: event.type as ArtifactEventType,
    };
}

function record(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
