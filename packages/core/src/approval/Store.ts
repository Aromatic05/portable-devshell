import {
    AuditDatabase,
    type StateStore,
} from "../audit/database/Database.js";
import { resolveAuditStorageLimits } from "../audit/database/Limits.js";
import type { ApprovalRequest } from "@portable-devshell/shared";

import type { ApprovalStorePort } from "./execution/Service.js";

export class InstanceApprovalStore implements ApprovalStorePort {
    readonly #database: AuditDatabase;
    readonly #store: StateStore<ApprovalRequest>;

    constructor(filePath: string) {
        this.#database = new AuditDatabase(
            filePath,
            resolveAuditStorageLimits(undefined),
        );
        this.#store = this.#database.stateStore<ApprovalRequest>("approvals");
    }

    append(request: ApprovalRequest): Promise<void> {
        return this.#store.put(request.approvalId, request);
    }

    get(approvalId: string): Promise<ApprovalRequest | undefined> {
        return this.#store.get(approvalId);
    }

    delete(approvalId: string): Promise<void> {
        return this.#store.delete(approvalId);
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
