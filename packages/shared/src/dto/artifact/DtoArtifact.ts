export const artifactShareStates = ["active", "expired", "revoked"] as const;
export type ArtifactShareState = (typeof artifactShareStates)[number];

export const artifactTransferStatuses = [
    "queued",
    "preparing",
    "transferring",
    "verifying",
    "committing",
    "completed",
    "failed",
    "cancelling",
    "cancelled",
    "interrupted"
] as const;
export type ArtifactTransferStatus = (typeof artifactTransferStatuses)[number];

const terminalArtifactTransferStatuses = new Set<ArtifactTransferStatus>([
    "completed",
    "failed",
    "cancelled",
    "interrupted"
]);

export function isArtifactTransferTerminal(status: ArtifactTransferStatus): boolean {
    return terminalArtifactTransferStatuses.has(status);
}

export function recoverArtifactTransferStatus(status: ArtifactTransferStatus): ArtifactTransferStatus {
    if (status === "queued" || isArtifactTransferTerminal(status)) {
        return status;
    }
    return "interrupted";
}

export type ArtifactSourceType = "artifact" | "file" | "directory";

export interface ArtifactSourceDescriptor {
    handle?: string;
    instance: string;
    path?: string;
    type?: ArtifactSourceType;
}

export interface ArtifactTargetDescriptor {
    instance: string;
    path: string;
}

export interface ArtifactPayloadDescriptorBase {
    mediaType: string;
    name: string;
    payloadBlake3: string;
    payloadBytes: number;
}

export interface ArtifactBytePayloadDescriptor extends ArtifactPayloadDescriptorBase {
    type: "stdout" | "stderr" | "file";
}

export interface ArtifactDirectoryPayloadDescriptor extends ArtifactPayloadDescriptorBase {
    entryCount: number;
    logicalBytes: number;
    manifestBlake3: string;
    type: "directoryArchive";
}

export type ArtifactPayloadDescriptor = ArtifactBytePayloadDescriptor | ArtifactDirectoryPayloadDescriptor;

export type ArtifactShareInput =
    | {
          expiresInSeconds?: number;
          handle: string;
          instance?: string;
          path?: never;
      }
    | {
          expiresInSeconds?: number;
          handle?: never;
          instance?: string;
          path: string;
      };

export interface ArtifactShareResult {
    blake3: string;
    bytes: number;
    downloadName: string;
    expiresAtMs: number;
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

export type ArtifactTransferSourceInput =
    | {
          handle: string;
          instance?: string;
          sourcePath?: never;
      }
    | {
          handle?: never;
          instance?: string;
          sourcePath: string;
      };

export type ArtifactTransferStartInput = ArtifactTransferSourceInput & {
    operation: "start";
    overwrite?: boolean;
    targetInstance: string;
    targetPath: string;
};

export interface ArtifactTransferLookupInput {
    operation: "status";
    transferId: string;
}

export interface ArtifactTransferCancelInput {
    operation: "cancel";
    transferId: string;
}

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

export const artifactEventTypes = [
    "artifact.shareCreated",
    "artifact.shareDownloaded",
    "artifact.shareExpired",
    "artifact.shareRevoked",
    "artifact.transferStarted",
    "artifact.transferProgress",
    "artifact.transferCompleted",
    "artifact.transferFailed",
    "artifact.transferCancelled",
    "artifact.transferInterrupted"
] as const;
export type ArtifactEventType = (typeof artifactEventTypes)[number];

