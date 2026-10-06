// Artifact domain model: worker-backed images, Control-managed shares, and
// cross-instance transfers. Transport lives in ./Transport.ts.

import type { JsonValue } from "../../types/Json.js";

export type ArtifactImageMediaType =
    "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ArtifactImageContent {
    blake3: string;
    bytes: number;
    content: string;
    encoding: "base64";
    imageRef: string;
    mediaType: ArtifactImageMediaType;
}

export type ArtifactViewImageInput =
    | {
          handle: string;
          instance?: string;
          path?: never;
      }
    | {
          handle?: never;
          instance?: string;
          path: string;
          workspace: string;
      };

export interface ArtifactViewImageResult extends ArtifactImageContent {
    name: string;
    source: ArtifactSourceDescriptor;
}

const artifactShareStates = [
    "active",
    "exhausted",
    "expired",
    "revoked",
] as const;
export type ArtifactShareState = (typeof artifactShareStates)[number];

export type ArtifactShareInput =
    | {
          expiresInSeconds?: number;
          handle: string;
          instance?: string;
          maxDownloads?: number;
          path?: never;
      }
    | {
          expiresInSeconds?: number;
          handle?: never;
          instance?: string;
          maxDownloads?: number;
          path: string;
          workspace: string;
      };

export interface ArtifactShareResult {
    blake3: string;
    bytes: number;
    downloadCount?: number;
    downloadName: string;
    expiresAtMs: number;
    maxDownloads?: number;
    mediaType: string;
    shareId: string;
    source: ArtifactSourceDescriptor;
    state: ArtifactShareState;
    url: string;
}

export interface ArtifactShareRevokeResult {
    revoked: true;
    shareId: string;
}

const artifactTransferStatuses = [
    "queued",
    "preparing",
    "transferring",
    "verifying",
    "committing",
    "completed",
    "failed",
    "cancelling",
    "cancelled",
    "interrupted",
] as const;
export type ArtifactTransferStatus = (typeof artifactTransferStatuses)[number];

const terminalArtifactTransferStatuses = new Set<ArtifactTransferStatus>([
    "completed",
    "failed",
    "cancelled",
    "interrupted",
]);

export function isArtifactTransferTerminal(
    status: ArtifactTransferStatus,
): boolean {
    return terminalArtifactTransferStatuses.has(status);
}

export function recoverArtifactTransferStatus(
    status: ArtifactTransferStatus,
): ArtifactTransferStatus {
    if (status === "queued" || isArtifactTransferTerminal(status))
        return status;
    return "interrupted";
}

export interface ArtifactSourceDescriptor {
    handle?: string;
    instance: string;
    path?: string;
    type?: "artifact" | "file" | "directory";
    workspace?: string;
}

export interface ArtifactTargetDescriptor {
    instance: string;
    path: string;
    workspace?: string;
}

export type ArtifactPayloadDescriptor = {
    mediaType: string;
    name: string;
    payloadBlake3: string;
    payloadBytes: number;
} & (
    | {
          type: "stdout" | "stderr" | "file";
      }
    | {
          entryCount: number;
          logicalBytes: number;
          manifestBlake3: string;
          type: "directoryArchive";
      }
);

export interface ArtifactPayloadChunk {
    bytes: Uint8Array;
    eof: boolean;
    nextOffsetBytes?: number;
    offsetBytes: number;
    payloadId: string;
    returnedBytes: number;
    totalBytes: number;
}

export type ArtifactTransferStartInput = (
    | {
          handle: string;
          instance?: string;
          sourcePath?: never;
      }
    | {
          handle?: never;
          instance?: string;
          sourcePath: string;
          sourceWorkspace: string;
      }
) & {
    operation: "start";
    overwrite?: boolean;
    targetInstance: string;
    targetPath: string;
    targetWorkspace: string;
};

export interface ArtifactTransferFailure {
    code: string;
    message: string;
    retryable: boolean;
}

export interface ArtifactTransferRecord {
    completedAt?: string;
    createdAt: string;
    failure?: ArtifactTransferFailure;
    payload?: ArtifactPayloadDescriptor;
    source: ArtifactSourceDescriptor;
    startedAt?: string;
    status: ArtifactTransferStatus;
    target: ArtifactTargetDescriptor;
    totalBytes?: number;
    transferId: string;
    transferredBytes: number;
    updatedAt: string;
}

export interface ArtifactTransferResult {
    operation: "cancel" | "start" | "status";
    transfer: ArtifactTransferRecord;
}

/**
 * One race-safe authoritative read of the whole artifact domain. `lastSeq` is
 * the global event cursor captured in the same synchronous read as the share
 * and transfer lists, so a subscriber that resumes from `lastSeq + 1` cannot
 * miss an event that is not already reflected here.
 */
export interface ArtifactSnapshot {
    lastSeq: number;
    shares: ArtifactShareResult[];
    transfers: ArtifactTransferRecord[];
}

const artifactEventTypes = [
    "artifact.shareCreated",
    "artifact.shareDownloaded",
    "artifact.shareExhausted",
    "artifact.shareExpired",
    "artifact.shareRevoked",
    "artifact.transferStarted",
    "artifact.transferProgress",
    "artifact.transferCompleted",
    "artifact.transferFailed",
    "artifact.transferCancelled",
    "artifact.transferInterrupted",
] as const;
export type ArtifactEventType = (typeof artifactEventTypes)[number];

/**
 * A change signal for the artifact domain. Artifact state is global (shares and
 * transfers are not scoped to one instance), so the dedicated artifact stream
 * carries the authority instance alongside a global sequence.
 */
export interface ArtifactEvent {
    at: string;
    data?: JsonValue;
    instance: string;
    seq: number;
    type: ArtifactEventType;
}

// Artifact bounded-context error codes. Artifact failures are raised by the
// artifact control port and its hosts; the values are the wire codes carried in
// RemoteErrorBody.code.

export const artifactErrorCodes = {
    contentUnavailable: "artifact.contentUnavailable",
    directoryUnsafe: "artifact.directoryUnsafe",
    hostPathDenied: "artifact.hostPathDenied",
    imageTooLarge: "artifact.imageTooLarge",
    imageUnsupported: "artifact.imageUnsupported",
    payloadInvalid: "artifact.payloadInvalid",
    shareExhausted: "artifact.shareExhausted",
    shareExpired: "artifact.shareExpired",
    shareNotFound: "artifact.shareNotFound",
    shareRevoked: "artifact.shareRevoked",
    transferInterrupted: "artifact.transferInterrupted",
    transferNotFound: "artifact.transferNotFound",
    transferStateConflict: "artifact.transferStateConflict",
} as const;
