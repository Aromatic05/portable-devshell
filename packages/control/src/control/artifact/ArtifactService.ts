import type { WorkerArtifactPayloadReadResult } from "@portable-devshell/core";
import type {
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactTransferCancelInput,
    ArtifactTransferLookupInput,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
    JsonValue
} from "@portable-devshell/shared";

import { ArtifactRecordStore } from "./ArtifactRecordStore.js";
import { ArtifactShareService } from "./ArtifactShareService.js";
import type {
    ArtifactServiceOptions,
    ArtifactShareAccess
} from "./ArtifactServiceModel.js";
import { ArtifactTransferService } from "./ArtifactTransferService.js";

export type {
    ArtifactServiceEndpoint,
    ArtifactServiceOptions,
    ArtifactServiceSchedule,
    ArtifactShareAccess
} from "./ArtifactServiceModel.js";

export class ArtifactService {
    readonly #recordStore: ArtifactRecordStore;
    readonly #shareService: ArtifactShareService;
    readonly #transferService: ArtifactTransferService;
    #initialized = false;

    constructor(options: ArtifactServiceOptions) {
        this.#recordStore = new ArtifactRecordStore(options.storageDir);
        this.#shareService = new ArtifactShareService({
            recordStore: this.#recordStore,
            resolveEndpoint: options.resolveEndpoint,
            shareUrl: options.shareUrl
        });
        this.#transferService = new ArtifactTransferService({
            chunkBytes: options.chunkBytes,
            recordStore: this.#recordStore,
            resolveEndpoint: options.resolveEndpoint,
            schedule: options.schedule
        });
    }

    async initialize(): Promise<void> {
        if (this.#initialized) {
            return;
        }

        await this.#recordStore.initialize();
        await this.#shareService.initialize();
        await this.#transferService.initialize();
        this.#initialized = true;
    }

    async stop(): Promise<void> {
        if (!this.#initialized) {
            return;
        }

        this.#initialized = false;
        this.#shareService.stop();
        await this.#transferService.stop();
    }

    async createShare(
        input: ArtifactShareInput,
        defaultInstance: string
    ): Promise<ArtifactShareResult> {
        return await this.#shareService.createShare(input, defaultInstance);
    }

    listShares(): ArtifactShareResult[] {
        return this.#shareService.listShares();
    }

    async revokeShare(shareId: string): Promise<ArtifactShareRevokeResult> {
        return await this.#shareService.revokeShare(shareId);
    }

    async resolveShare(token: string): Promise<ArtifactShareAccess> {
        return await this.#shareService.resolveShare(token);
    }

    async readSharePayload(
        token: string,
        offsetBytes: number,
        maxBytes: number
    ): Promise<WorkerArtifactPayloadReadResult> {
        return await this.#shareService.readSharePayload(
            token,
            offsetBytes,
            maxBytes
        );
    }

    async recordShareDownloaded(
        token: string,
        details?: JsonValue
    ): Promise<void> {
        await this.#shareService.recordShareDownloaded(token, details);
    }

    async startTransfer(
        input: ArtifactTransferStartInput,
        defaultInstance: string
    ): Promise<ArtifactTransferResult> {
        return await this.#transferService.startTransfer(
            input,
            defaultInstance
        );
    }

    getTransfer(transferId: string): ArtifactTransferRecord {
        return this.#transferService.getTransfer(transferId);
    }

    listTransfers(): ArtifactTransferRecord[] {
        return this.#transferService.listTransfers();
    }

    async lookupTransfer(
        input: ArtifactTransferLookupInput
    ): Promise<ArtifactTransferResult> {
        return await this.#transferService.lookupTransfer(input);
    }

    async cancelTransfer(
        input: ArtifactTransferCancelInput | string
    ): Promise<ArtifactTransferResult> {
        return await this.#transferService.cancelTransfer(input);
    }

    async waitForTransfer(transferId: string): Promise<ArtifactTransferRecord> {
        return await this.#transferService.waitForTransfer(transferId);
    }
}
