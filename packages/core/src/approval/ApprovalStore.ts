import type { ApprovalRequest } from "@portable-devshell/shared";

import type { AuditRecordStore } from "../audit/AuditRecordStore.js";

export class ApprovalStore {
    readonly #store: AuditRecordStore<ApprovalRequest>;

    constructor(store: AuditRecordStore<ApprovalRequest>) {
        this.#store = store;
    }

    async append(request: ApprovalRequest): Promise<void> {
        await this.#store.append(request);
    }

    async get(approvalId: string): Promise<ApprovalRequest | undefined> {
        return toLatestRequests(await this.#store.readAll()).find((request) => request.approvalId === approvalId);
    }

    async list(): Promise<ApprovalRequest[]> {
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
