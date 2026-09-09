import type {
    ExtensionArtifactCapability,
    ExtensionArtifactShareInput,
    ExtensionArtifactShareRecord,
    ExtensionArtifactShareRevokeResult,
    ExtensionArtifactSource,
    ExtensionArtifactTarget,
    ExtensionArtifactTransferInput,
    ExtensionArtifactTransferRecord,
    ExtensionArtifactTransferResult
} from "@portable-devshell/extension/artifact";
import type {
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactSourceDescriptor,
    ArtifactTargetDescriptor,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput
} from "@portable-devshell/shared";

import type { ArtifactService } from "../../../../artifact/ArtifactService.js";

export interface ExtensionArtifactCapabilityControlOptions {
    allowed: boolean;
    extensionId: string;
    service: Pick<
        ArtifactService,
        | "cancelTransfer"
        | "createShare"
        | "getTransfer"
        | "listShares"
        | "listTransfers"
        | "revokeShare"
        | "startTransfer"
        | "waitForTransfer"
    >;
}

/** Public Artifact management capability backed by the Control-owned Artifact domain. */
export class ExtensionArtifactCapabilityControl implements ExtensionArtifactCapability {
    readonly #allowed: boolean;
    readonly #extensionId: string;
    readonly #service: ExtensionArtifactCapabilityControlOptions["service"];

    constructor(options: ExtensionArtifactCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#extensionId = options.extensionId;
        this.#service = options.service;
    }

    async createShare(input: ExtensionArtifactShareInput): Promise<ExtensionArtifactShareRecord> {
        this.#assertAllowed();
        const source = toShareInput(input);
        return toShareRecord(await this.#service.createShare(source, input.authorityInstance));
    }

    async listShares(): Promise<readonly ExtensionArtifactShareRecord[]> {
        this.#assertAllowed();
        return this.#service.listShares().map(toShareRecord);
    }

    async revokeShare(shareId: string): Promise<ExtensionArtifactShareRevokeResult> {
        this.#assertAllowed();
        return await this.#service.revokeShare(requireText(shareId, "shareId"));
    }

    async startTransfer(input: ExtensionArtifactTransferInput): Promise<ExtensionArtifactTransferResult> {
        this.#assertAllowed();
        return toTransferResult(await this.#service.startTransfer(toTransferStartInput(input), input.authorityInstance));
    }

    async getTransfer(transferId: string): Promise<ExtensionArtifactTransferRecord> {
        this.#assertAllowed();
        return toTransferRecord(this.#service.getTransfer(requireText(transferId, "transferId")));
    }

    async listTransfers(): Promise<readonly ExtensionArtifactTransferRecord[]> {
        this.#assertAllowed();
        return this.#service.listTransfers().map(toTransferRecord);
    }

    async cancelTransfer(transferId: string): Promise<ExtensionArtifactTransferResult> {
        this.#assertAllowed();
        return toTransferResult(await this.#service.cancelTransfer(requireText(transferId, "transferId")));
    }

    async waitForTransfer(transferId: string): Promise<ExtensionArtifactTransferRecord> {
        this.#assertAllowed();
        return toTransferRecord(await this.#service.waitForTransfer(requireText(transferId, "transferId")));
    }

    #assertAllowed(): void {
        if (this.#allowed) return;
        throw new Error(`Extension ${this.#extensionId} did not declare the artifacts capability.`);
    }
}

function toShareInput(input: ExtensionArtifactShareInput): ArtifactShareInput {
    const source = input.source;
    return source.handle !== undefined
        ? {
            ...(input.expiresInSeconds === undefined ? {} : { expiresInSeconds: input.expiresInSeconds }),
            handle: requireText(source.handle, "source.handle"),
            instance: requireText(source.instance, "source.instance"),
            ...(input.maxDownloads === undefined ? {} : { maxDownloads: input.maxDownloads })
        }
        : {
            ...(input.expiresInSeconds === undefined ? {} : { expiresInSeconds: input.expiresInSeconds }),
            instance: requireText(source.instance, "source.instance"),
            ...(input.maxDownloads === undefined ? {} : { maxDownloads: input.maxDownloads }),
            path: requireText(source.path, "source.path"),
            workspace: requireText(source.workspace, "source.workspace")
        };
}

function toTransferStartInput(input: ExtensionArtifactTransferInput): ArtifactTransferStartInput {
    const common = {
        instance: requireText(input.source.instance, "source.instance"),
        operation: "start" as const,
        ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
        targetInstance: requireText(input.target.instance, "target.instance"),
        targetPath: requireText(input.target.path, "target.path"),
        targetWorkspace: requireText(input.target.workspace, "target.workspace")
    };
    return input.source.handle !== undefined
        ? { ...common, handle: requireText(input.source.handle, "source.handle") }
        : {
            ...common,
            sourcePath: requireText(input.source.path, "source.path"),
            sourceWorkspace: requireText(input.source.workspace, "source.workspace")
        };
}

function toShareRecord(value: ArtifactShareResult): ExtensionArtifactShareRecord {
    return {
        blake3: value.blake3,
        bytes: value.bytes,
        ...(value.downloadCount === undefined ? {} : { downloadCount: value.downloadCount }),
        downloadName: value.downloadName,
        expiresAtMs: value.expiresAtMs,
        ...(value.maxDownloads === undefined ? {} : { maxDownloads: value.maxDownloads }),
        mediaType: value.mediaType,
        shareId: value.shareId,
        source: toSource(value.source),
        state: value.state,
        url: value.url
    };
}

function toTransferResult(value: ArtifactTransferResult): ExtensionArtifactTransferResult {
    return { operation: value.operation, transfer: toTransferRecord(value.transfer) };
}

function toTransferRecord(value: ArtifactTransferRecord): ExtensionArtifactTransferRecord {
    return {
        ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
        createdAt: value.createdAt,
        ...(value.failure === undefined ? {} : { failure: { ...value.failure } }),
        ...(value.payload === undefined ? {} : { payload: { ...value.payload } }),
        source: toSource(value.source),
        ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
        status: value.status,
        target: toTarget(value.target),
        ...(value.totalBytes === undefined ? {} : { totalBytes: value.totalBytes }),
        transferId: value.transferId,
        transferredBytes: value.transferredBytes,
        updatedAt: value.updatedAt
    };
}

function toSource(value: ArtifactSourceDescriptor): ExtensionArtifactSource {
    if (value.handle !== undefined) {
        return { handle: value.handle, instance: value.instance };
    }
    if (value.path !== undefined && value.workspace !== undefined) {
        return { instance: value.instance, path: value.path, workspace: value.workspace };
    }
    throw new Error("Artifact source record is missing its handle or path/workspace identity.");
}

function toTarget(value: ArtifactTargetDescriptor): ExtensionArtifactTarget {
    if (value.workspace === undefined) {
        throw new Error("Artifact target record is missing its workspace identity.");
    }
    return { instance: value.instance, path: value.path, workspace: value.workspace };
}

function requireText(value: string, field: string): string {
    if (value.trim().length > 0) return value;
    throw new TypeError(`Extension artifacts ${field} must be a non-empty string.`);
}
