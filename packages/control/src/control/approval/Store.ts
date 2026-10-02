import {
    AuditDatabase,
    resolveAuditStorageLimits,
    type AuditApprovalRecordStore,
} from "@portable-devshell/core";
import type { ApprovalRequest } from "@portable-devshell/shared";

import type { ApprovalStorePort } from "./Service.js";

export class InstanceApprovalStore implements ApprovalStorePort {
    readonly #database: AuditDatabase;
    readonly #store: AuditApprovalRecordStore;

    constructor(
        filePath: string,
        legacyFile: string,
        limits?: { maxBytes?: number; retentionDays?: number },
    ) {
        this.#database = new AuditDatabase(
            filePath,
            resolveAuditStorageLimits(limits),
        );
        this.#store = this.#database.approvalStore({
            legacyFile,
            timestamp: (request) => request.createdAt,
        });
    }

    append(request: ApprovalRequest): Promise<void> {
        return this.#store.append(request);
    }

    async get(approvalId: string): Promise<ApprovalRequest | undefined> {
        return (await this.#store.readLatest(approvalId))[0];
    }

    list(): Promise<ApprovalRequest[]> {
        return this.#store.readLatest();
    }

    close(): void {
        this.#database.close();
    }
}
