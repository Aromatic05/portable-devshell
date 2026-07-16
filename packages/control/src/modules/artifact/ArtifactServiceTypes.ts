import type {
    WorkerArtifactPayloadOpenInput,
    WorkerArtifactPayloadOpenResult,
    WorkerArtifactPayloadReadInput,
    WorkerArtifactPayloadReadResult,
    WorkerArtifactReceiveBeginInput,
    WorkerArtifactReceiveBeginResult,
    WorkerArtifactReceiveFinishResult,
    WorkerArtifactReceiveWriteInput,
    WorkerArtifactReceiveWriteResult
} from "@portable-devshell/core";
import type {
    ArtifactEventType,
    ArtifactShareResult,
    ArtifactTransferRecord,
    ArtifactTransferStartInput,
    JsonValue
} from "@portable-devshell/shared";

export const ARTIFACT_RECORD_VERSION = 1;
export const DEFAULT_ARTIFACT_CHUNK_BYTES = 512 * 1024;
export const DEFAULT_ARTIFACT_SHARE_TTL_SECONDS = 60 * 60;
export const MAX_ARTIFACT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const ARTIFACT_TRANSFER_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export type ArtifactServiceSchedule = (task: () => void) => void;

export interface ArtifactServiceEndpoint {
    abortArtifactReceive(receiveId: string): Promise<void>;
    appendControlEvent(type: ArtifactEventType, data?: JsonValue): Promise<unknown>;
    beginArtifactReceive(input: WorkerArtifactReceiveBeginInput): Promise<WorkerArtifactReceiveBeginResult>;
    closeArtifactPayload(payloadId: string): Promise<void>;
    finishArtifactReceive(receiveId: string): Promise<WorkerArtifactReceiveFinishResult>;
    openArtifactPayload(input: WorkerArtifactPayloadOpenInput): Promise<WorkerArtifactPayloadOpenResult>;
    readArtifactPayload(input: WorkerArtifactPayloadReadInput): Promise<WorkerArtifactPayloadReadResult>;
    writeArtifactReceive(input: WorkerArtifactReceiveWriteInput): Promise<WorkerArtifactReceiveWriteResult>;
}

export interface ArtifactServiceOptions {
    chunkBytes?: number;
    resolveEndpoint: (instance: string, authorityInstance?: string) => ArtifactServiceEndpoint | undefined;
    schedule?: ArtifactServiceSchedule;
    shareUrl: (token: string) => string;
    storageDir: string;
}

export interface StoredArtifactShare {
    authorityInstance: string;
    payloadClosed: boolean;
    payloadId: string;
    result: ArtifactShareResult;
    sourceInstance: string;
    token: string;
    version: number;
}

export interface StoredArtifactTransfer {
    cancelRequested: boolean;
    defaultInstance: string;
    payloadId?: string;
    receiveId?: string;
    record: ArtifactTransferRecord;
    request: ArtifactTransferStartInput;
    version: number;
}

export interface ArtifactShareAccess {
    payloadId: string;
    share: ArtifactShareResult;
    sourceInstance: string;
}

export type ArtifactPayloadSourceInput = { handle: string } | { path: string };
