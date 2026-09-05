import type { ApprovalRequest } from "@portable-devshell/shared";

import type { AuditRecordStore } from "../audit/AuditRecordStore.js";

interface ApprovalRecordStore extends AuditRecordStore<ApprovalRequest> {
    readLatest?(approvalId?: string): Promise<ApprovalRequest[]>;
}

export class ApprovalStore {
    readonly #store: ApprovalRecordStore;

    constructor(store: ApprovalRecordStore) {
        this.#store = store;
    }

    async append(request: ApprovalRequest): Promise<void> {
        await this.#store.append(request);
    }

    async get(approvalId: string): Promise<ApprovalRequest | undefined> {
        if (this.#store.readLatest !== undefined) {
            return (await this.#store.readLatest(approvalId))[0];
        }
        return toLatestRequests(await this.#store.readAll()).find((request) => request.approvalId === approvalId);
    }

    async list(): Promise<ApprovalRequest[]> {
        if (this.#store.readLatest !== undefined) {
            return await this.#store.readLatest();
        }
        return toLatestRequests(await this.#store.readAll());
    }
}

function toLatestRequests(records: ApprovalRequest[]): ApprovalRequest[] {
    const latest = new Map<string, ApprovalRequest>();
    for (const record of records) {
        latest.set(record.approvalId, record);
    }
    return [...latest.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
