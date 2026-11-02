import {
    type EventStreamPort,
    EventStreamReader,
    readStreamGapPayload,
} from "../../client/Stream.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { JsonValue } from "../../types/Json.js";
import type {
    ArtifactEvent,
    ArtifactEventType,
    ArtifactImageContent,
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactSnapshot,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
} from "./Model.js";

export interface ArtifactTransport {
    cancelTransfer(transferId: string, signal?: AbortSignal): Promise<ArtifactTransferResult>;
    createShare(
        defaultInstance: string,
        input: ArtifactShareInput,
        signal?: AbortSignal,
    ): Promise<ArtifactShareResult>;
    getTransfer(transferId: string): Promise<ArtifactTransferRecord>;
    readImage(imageRef: string): Promise<ArtifactImageContent>;
    revokeShare(shareId: string, signal?: AbortSignal): Promise<ArtifactShareRevokeResult>;
    snapshot(): Promise<ArtifactSnapshot>;
    startTransfer(
        defaultInstance: string,
        input: ArtifactTransferStartInput,
        signal?: AbortSignal,
    ): Promise<ArtifactTransferResult>;
    subscribe(fromSeq: number): Promise<EventStreamPort<ArtifactEvent>>;
    viewImage(
        defaultInstance: string,
        input: ArtifactViewImageInput,
    ): Promise<ArtifactViewImageResult>;
}

export function createArtifactTransport(endpoint: Endpoint): ArtifactTransport {
    const port = createPortClient(endpoint, "@control", "artifact");
    return {
        cancelTransfer: (transferId, signal) =>
            port.request<ArtifactTransferResult>("cancelTransfer", {
                transferId,
            }, signal),
        createShare: (defaultInstance, input, signal) =>
            port.request<ArtifactShareResult>("createShare", {
                ...input,
                defaultInstance,
            }, signal),
        getTransfer: (transferId) =>
            port.request<ArtifactTransferRecord>("getTransfer", { transferId }),
        readImage: (imageRef) =>
            port.request<ArtifactImageContent>("readImage", { imageRef }),
        revokeShare: (shareId, signal) =>
            port.request<ArtifactShareRevokeResult>("revokeShare", { shareId }, signal),
        snapshot: () => port.request<ArtifactSnapshot>("snapshot"),
        startTransfer: (defaultInstance, input, signal) =>
            port.request<ArtifactTransferResult>("startTransfer", {
                ...input,
                defaultInstance,
            }, signal),
        subscribe: async (fromSeq) =>
            new EventStreamReader<ArtifactEvent>(
                await port.open("subscribe", { fromSeq }),
                {
                    decodeEvent: readArtifactEvent,
                    readGap: readStreamGapPayload,
                },
            ),
        viewImage: (defaultInstance, input) =>
            port.request<ArtifactViewImageResult>("viewImage", {
                ...input,
                defaultInstance,
            }),
    };
}

function readArtifactEvent(value: JsonValue | undefined): ArtifactEvent {
    const event = record(value);
    if (
        event === undefined ||
        typeof event.at !== "string" ||
        typeof event.instance !== "string" ||
        typeof event.seq !== "number" ||
        typeof event.type !== "string"
    ) {
        throw new Error("Invalid artifact event.");
    }
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
