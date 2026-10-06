import type {
    ArtifactPayloadChunk,
    ArtifactPayloadDescriptor,
} from "./Model.js";

export interface WorkerArtifactApi {
    openArtifactPayload(
        input:
            | { expiresAtMs: number; handle: string; path?: never }
            | {
                  expiresAtMs: number;
                  handle?: never;
                  path: string;
                  workspace: string;
              },
        signal?: AbortSignal,
    ): Promise<{
        descriptor: ArtifactPayloadDescriptor;
        expiresAtMs: number;
        payloadId: string;
    }>;
    readArtifactPayload(
        input: { maxBytes: number; offsetBytes: number; payloadId: string },
        signal?: AbortSignal,
    ): Promise<ArtifactPayloadChunk>;
    closeArtifactPayload(payloadId: string): Promise<void>;
    beginArtifactReceive(
        input: {
            descriptor: ArtifactPayloadDescriptor;
            overwrite: boolean;
            targetPath: string;
            workspace: string;
        },
        signal?: AbortSignal,
    ): Promise<{ nextOffsetBytes: number; receiveId: string }>;
    writeArtifactReceive(
        input: { bytes: Uint8Array; offsetBytes: number; receiveId: string },
        signal?: AbortSignal,
    ): Promise<{
        nextOffsetBytes: number;
        receivedBytes: number;
        receiveId: string;
    }>;
    finishArtifactReceive(receiveId: string): Promise<{
        blake3: string;
        bytes: number;
        receiveId: string;
        targetPath: string;
    }>;
    abortArtifactReceive(receiveId: string): Promise<void>;
    openArtifactDirectReceive?(
        input: { expiresAtMs: number; receiveId: string },
        signal?: AbortSignal,
    ): Promise<{
        expiresAtMs: number;
        nextOffsetBytes: number;
        receiverId: string;
        urls: string[];
    }>;
    closeArtifactDirectReceive?(receiverId: string): Promise<void>;
    pushArtifactPayloadDirect?(input: {
        maxBytes: number;
        offsetBytes: number;
        payloadId: string;
        urls: string[];
    }): Promise<{ nextOffsetBytes: number; pushedBytes: number }>;
}
