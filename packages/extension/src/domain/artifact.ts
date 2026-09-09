export type ExtensionArtifactShareState = "active" | "exhausted" | "expired" | "revoked";

export type ExtensionArtifactTransferStatus =
    | "queued"
    | "preparing"
    | "transferring"
    | "verifying"
    | "committing"
    | "completed"
    | "failed"
    | "cancelling"
    | "cancelled"
    | "interrupted";

export type ExtensionArtifactSource =
    | {
          handle: string;
          instance: string;
          path?: never;
          workspace?: never;
      }
    | {
          handle?: never;
          instance: string;
          path: string;
          workspace: string;
      };

export interface ExtensionArtifactTarget {
    instance: string;
    path: string;
    workspace: string;
}

export interface ExtensionArtifactShareInput {
    authorityInstance: string;
    expiresInSeconds?: number;
    maxDownloads?: number;
    source: ExtensionArtifactSource;
}

export interface ExtensionArtifactShareRecord {
    blake3: string;
    bytes: number;
    downloadCount?: number;
    downloadName: string;
    expiresAtMs: number;
    maxDownloads?: number;
    mediaType: string;
    shareId: string;
    source: ExtensionArtifactSource;
    state: ExtensionArtifactShareState;
    url: string;
}

export interface ExtensionArtifactShareRevokeResult {
    revoked: true;
    shareId: string;
}

export interface ExtensionArtifactTransferFailure {
    code: string;
    message: string;
    retryable: boolean;
}

export interface ExtensionArtifactTransferPayload {
    entryCount?: number;
    logicalBytes?: number;
    manifestBlake3?: string;
    mediaType: string;
    name: string;
    payloadBlake3: string;
    payloadBytes: number;
    type: "directoryArchive" | "file" | "stderr" | "stdout";
}

export interface ExtensionArtifactTransferRecord {
    completedAt?: string;
    createdAt: string;
    failure?: ExtensionArtifactTransferFailure;
    payload?: ExtensionArtifactTransferPayload;
    source: ExtensionArtifactSource;
    startedAt?: string;
    status: ExtensionArtifactTransferStatus;
    target: ExtensionArtifactTarget;
    totalBytes?: number;
    transferId: string;
    transferredBytes: number;
    updatedAt: string;
}

export interface ExtensionArtifactTransferInput {
    authorityInstance: string;
    overwrite?: boolean;
    source: ExtensionArtifactSource;
    target: ExtensionArtifactTarget;
}

export interface ExtensionArtifactTransferResult {
    operation: "cancel" | "start" | "status";
    transfer: ExtensionArtifactTransferRecord;
}

/** Host-owned Artifact management operations available to an Extension generation. */
export interface ExtensionArtifactCapability {
    cancelTransfer(transferId: string): Promise<ExtensionArtifactTransferResult>;
    createShare(input: ExtensionArtifactShareInput): Promise<ExtensionArtifactShareRecord>;
    getTransfer(transferId: string): Promise<ExtensionArtifactTransferRecord>;
    listShares(): Promise<readonly ExtensionArtifactShareRecord[]>;
    listTransfers(): Promise<readonly ExtensionArtifactTransferRecord[]>;
    revokeShare(shareId: string): Promise<ExtensionArtifactShareRevokeResult>;
    startTransfer(input: ExtensionArtifactTransferInput): Promise<ExtensionArtifactTransferResult>;
    waitForTransfer(transferId: string): Promise<ExtensionArtifactTransferRecord>;
}
