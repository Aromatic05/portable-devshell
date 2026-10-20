import type { StateStore } from "../audit/Api.js";
import type { ApprovalRecord, ApprovalStorePort } from "./execution/Service.js";

export class InstanceApprovalStore implements ApprovalStorePort {
    readonly #store: StateStore<ApprovalRecord>;

    constructor(store: StateStore<ApprovalRecord>) {
        this.#store = store;
    }

    append(request: ApprovalRecord): Promise<void> {
        return this.#store.put(request.approvalId, request);
    }

    get(approvalId: string): Promise<ApprovalRecord | undefined> {
        return this.#store.get(approvalId);
    }

    delete(approvalId: string): Promise<void> {
        return this.#store.delete(approvalId);
    }

    async list(): Promise<ApprovalRecord[]> {
        return (await this.#store.list()).sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
        );
    }
}
