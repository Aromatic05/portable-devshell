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
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactSnapshot,
    ArtifactStoredImageResult,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
} from "./Model.js";

export interface ArtifactTransport {
    cancelTransfer(transferId: string): Promise<ArtifactTransferResult>;
    createShare(
        defaultInstance: string,
        input: ArtifactShareInput,
    ): Promise<ArtifactShareResult>;
    getTransfer(transferId: string): Promise<ArtifactTransferRecord>;
    readImage(imageRef: string): Promise<ArtifactStoredImageResult>;
    revokeShare(shareId: string): Promise<ArtifactShareRevokeResult>;
    snapshot(): Promise<ArtifactSnapshot>;
    startTransfer(
        defaultInstance: string,
        input: ArtifactTransferStartInput,
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
        cancelTransfer: (transferId) =>
            port.request<ArtifactTransferResult>("cancelTransfer", {
                transferId,
            }),
        createShare: (defaultInstance, input) =>
            port.request<ArtifactShareResult>("createShare", {
                ...input,
                defaultInstance,
            }),
        getTransfer: (transferId) =>
            port.request<ArtifactTransferRecord>("getTransfer", { transferId }),
        readImage: (imageRef) =>
            port.request<ArtifactStoredImageResult>("readImage", { imageRef }),
        revokeShare: (shareId) =>
            port.request<ArtifactShareRevokeResult>("revokeShare", { shareId }),
        snapshot: () => port.request<ArtifactSnapshot>("snapshot"),
        startTransfer: (defaultInstance, input) =>
            port.request<ArtifactTransferResult>("startTransfer", {
                ...input,
                defaultInstance,
            }),
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
