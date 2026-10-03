// Thin typed artifact transport over the generic endpoint/RPC/stream transport.
// One RPC connection is opened per operation. subscribe owns a dedicated
// artifact event stream; the server side of that stream is new work.

import type { Endpoint } from "../transport/endpoint/Endpoint.js";
import { Rpc } from "../transport/packet/Rpc.js";
import { Stream } from "../transport/packet/Stream.js";
import { EventStreamReader } from "../transport/stream/EventStream.js";
import type { JsonValue } from "../transport/primitive/JsonValue.js";
import {
    artifactOperations,
    readArtifactEvent,
    readArtifactStreamGapPayload,
    type ArtifactEventStreamPort,
    type ArtifactOperation,
    type ArtifactRequest,
    type ArtifactResponse,
    type ArtifactSubscribeRequest,
} from "./Contract.js";
import {
    type ArtifactEvent,
    type ArtifactShareInput,
    type ArtifactShareResult,
    type ArtifactShareRevokeResult,
    type ArtifactSnapshot,
    type ArtifactStoredImageResult,
    type ArtifactTransferRecord,
    type ArtifactTransferResult,
    type ArtifactTransferStartInput,
    type ArtifactViewImageInput,
    type ArtifactViewImageResult,
} from "./Model.js";

export const ARTIFACT_HOST = "@control";
export const ARTIFACT_PORT = "artifact";

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
    subscribe(fromSeq: number): Promise<ArtifactEventStreamPort>;
    viewImage(
        defaultInstance: string,
        input: ArtifactViewImageInput,
    ): Promise<ArtifactViewImageResult>;
}

export function createArtifactTransport(endpoint: Endpoint): ArtifactTransport {
    const request = async <Operation extends ArtifactOperation>(
        operation: Operation,
        payload: ArtifactRequest<Operation>,
    ): Promise<ArtifactResponse<Operation>> => {
        const rpc = new Rpc(
            await endpoint.connect(ARTIFACT_HOST, ARTIFACT_PORT),
        );
        try {
            return await rpc.request<ArtifactResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    return {
        cancelTransfer: (transferId) =>
            request(artifactOperations.cancelTransfer, { transferId }),
        createShare: (defaultInstance, input) =>
            request(artifactOperations.createShare, {
                ...input,
                defaultInstance,
            }),
        getTransfer: (transferId) =>
            request(artifactOperations.getTransfer, { transferId }),
        readImage: (imageRef) =>
            request(artifactOperations.readImage, { imageRef }),
        revokeShare: (shareId) =>
            request(artifactOperations.revokeShare, { shareId }),
        snapshot: () => request(artifactOperations.snapshot, undefined),
        startTransfer: (defaultInstance, input) =>
            request(artifactOperations.startTransfer, {
                ...input,
                defaultInstance,
            }),
        subscribe: async (fromSeq) => {
            const protocol = new Stream(
                await endpoint.connect(ARTIFACT_HOST, ARTIFACT_PORT),
            );
            const subscribeRequest: ArtifactSubscribeRequest = { fromSeq };
            const stream = await protocol.open(
                artifactOperations.subscribe,
                subscribeRequest as unknown as JsonValue,
            );
            const close = () => protocol.close();
            stream.onClose(close);
            stream.onCancel(close);
            return new EventStreamReader<ArtifactEvent>(stream, {
                decodeEvent: readArtifactEvent,
                readGap: readArtifactStreamGapPayload,
            });
        },
        viewImage: (defaultInstance, input) =>
            request(artifactOperations.viewImage, {
                ...input,
                defaultInstance,
            }),
    };
}
