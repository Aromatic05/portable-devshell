import {
    AuditDatabase,
    resolveAuditStorageLimits,
    type StateStore,
} from "@portable-devshell/core";
import type { ApprovalRequest } from "@portable-devshell/shared";

import type { ApprovalStorePort } from "./Service.js";

export class InstanceApprovalStore implements ApprovalStorePort {
    readonly #database: AuditDatabase;
    readonly #store: StateStore<ApprovalRequest>;

    constructor(filePath: string, legacyFile: string) {
        this.#database = new AuditDatabase(
            filePath,
            resolveAuditStorageLimits(undefined),
        );
        this.#store = this.#database.stateStore<ApprovalRequest>("approvals", {
            legacyCollection: "approvals",
            legacyFile,
            key: (request) => request.approvalId,
        });
    }

    append(request: ApprovalRequest): Promise<void> {
        return this.#store.put(request.approvalId, request);
    }

    get(approvalId: string): Promise<ApprovalRequest | undefined> {
        return this.#store.get(approvalId);
    }

    async list(): Promise<ApprovalRequest[]> {
        return (await this.#store.list()).sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
        );
    }

    close(): void {
        this.#database.close();
    }
}
