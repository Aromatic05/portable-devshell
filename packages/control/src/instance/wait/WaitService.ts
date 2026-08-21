import type {
    InstanceEventType,
    JsonValue,
    WaitCreateInput,
    WaitRecord,
} from "@portable-devshell/shared";

import { WaitState, type WaitDocument, type WaitTransition } from "./WaitState.js";
import { WaitStore } from "./WaitStore.js";

export interface WaitServiceOptions {
    appendEvent(type: Extract<InstanceEventType, `wait.${string}`>, data: JsonValue): Promise<void>;
    filePath: string;
    instanceName: string;
}

export class WaitService {
    readonly #appendEvent: WaitServiceOptions["appendEvent"];
    readonly #pending = new Map<string, {
        reject(error: Error): void;
        resolve(record: WaitRecord): void;
    }>();
    readonly #state: WaitState;
    readonly #store: WaitStore;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: WaitServiceOptions) {
        this.#appendEvent = options.appendEvent;
        this.#state = new WaitState();
        this.#store = new WaitStore({
            filePath: options.filePath,
            instanceName: options.instanceName,
            state: this.#state,
        });
    }

    async create(input: WaitCreateInput): Promise<WaitRecord> {
        return await this.#commit("wait.created", (document) => this.#state.create(document, input));
    }

    async detach(waitId: string): Promise<WaitRecord> {
        const record = await this.#commit("wait.detached", (document) => this.#state.detach(document, waitId));
        this.#notify(record);
        return record;
    }

    async reattach(waitId: string, ownerCallId?: string): Promise<WaitRecord> {
        return await this.#commit("wait.reattached", (document) => this.#state.reattach(document, waitId, ownerCallId));
    }

    async resolve(waitId: string, result?: JsonValue): Promise<WaitRecord> {
        const record = await this.#commit("wait.resolved", (document) => this.#state.resolve(document, waitId, result));
        this.#notify(record);
        return record;
    }

    async claimRecovery(waitId: string, claimId: string): Promise<WaitRecord> {
        return await this.#commit(
            "wait.recoveryClaimed",
            (document) => this.#state.claimRecovery(document, waitId, claimId),
        );
    }

    async releaseRecovery(waitId: string, claimId: string): Promise<WaitRecord> {
        return await this.#commit(
            "wait.recoveryReleased",
            (document) => this.#state.releaseRecovery(document, waitId, claimId),
        );
    }

    async markRecoverySent(waitId: string, claimId: string): Promise<WaitRecord> {
        return await this.#commit(
            "wait.recoveryMessageSent",
            (document) => this.#state.markRecoverySent(document, waitId, claimId),
        );
    }

    async completeRecovery(waitId: string, claimId: string): Promise<WaitRecord> {
        return await this.#commit(
            "wait.consumed",
            (document) => this.#state.completeRecovery(document, waitId, claimId),
        );
    }

    async consume(waitId: string): Promise<WaitRecord> {
        return await this.#commit("wait.consumed", (document) => this.#state.consume(document, waitId));
    }

    async cancel(waitId: string): Promise<WaitRecord> {
        const record = await this.#commit("wait.cancelled", (document) => this.#state.cancel(document, waitId));
        this.#notify(record);
        return record;
    }

    async get(waitId: string): Promise<WaitRecord | undefined> {
        await this.#operation;
        return this.#store.read().waits.find((record) => record.waitId === waitId);
    }

    async list(taskId?: string): Promise<WaitRecord[]> {
        await this.#operation;
        return this.#store.read().waits.filter((record) => taskId === undefined || record.taskId === taskId);
    }

    async waitForResolution(waitId: string): Promise<WaitRecord> {
        await this.#operation;
        const record = this.#store.read().waits.find((entry) => entry.waitId === waitId);
        if (record === undefined) throw new Error(`Wait ${waitId} was not found.`);
        if (record.status === "resolved") return record;
        if (record.status !== "waiting" && record.status !== "detached") {
            throw new Error(`Wait ${waitId} cannot be awaited while it is ${record.status}.`);
        }
        return await new Promise<WaitRecord>((resolve, reject) => {
            this.#pending.set(waitId, { reject, resolve });
        });
    }

    #notify(record: WaitRecord): void {
        const pending = this.#pending.get(record.waitId);
        if (pending === undefined) return;
        if (record.status === "resolved") {
            this.#pending.delete(record.waitId);
            pending.resolve(record);
            return;
        }
        if (record.status === "detached" || record.status === "cancelled") {
            this.#pending.delete(record.waitId);
            pending.reject(new Error(`Wait ${record.waitId} became ${record.status}.`));
        }
    }

    async #commit(
        eventType: Extract<InstanceEventType, `wait.${string}`>,
        transition: (document: WaitDocument) => WaitTransition,
    ): Promise<WaitRecord> {
        return await this.#runExclusive(async () => {
            const next = transition(this.#store.read());
            await this.#store.write(next.document);
            await this.#appendEvent(eventType, eventData(next.record)).catch(() => undefined);
            return next.record;
        });
    }

    async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#operation;
        let release!: () => void;
        this.#operation = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

function eventData(record: WaitRecord): JsonValue {
    return {
        createdAt: record.createdAt,
        createdByCtxId: record.createdByCtxId,
        ...(record.deadlineAt === undefined ? {} : { deadlineAt: record.deadlineAt }),
        ...(record.goalId === undefined ? {} : { goalId: record.goalId }),
        kind: record.kind,
        ...(record.ownerCallId === undefined ? {} : { ownerCallId: record.ownerCallId }),
        status: record.status,
        ...(record.recoveryMessageId === undefined ? {} : { recoveryMessageId: record.recoveryMessageId }),
        ...(record.recoveryMessageSentAt === undefined ? {} : { recoveryMessageSentAt: record.recoveryMessageSentAt }),
        targetId: record.targetId,
        ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
        updatedAt: record.updatedAt,
        waitId: record.waitId,
    };
}
