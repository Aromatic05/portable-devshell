import type { StateStore } from "../audit/Public.js";
import type { ApprovalRequest } from "@portable-devshell/shared";

import type { ApprovalStorePort } from "./execution/Service.js";

export class InstanceApprovalStore implements ApprovalStorePort {
    readonly #store: StateStore<ApprovalRequest>;

    constructor(store: StateStore<ApprovalRequest>) {
        this.#store = store;
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
}
