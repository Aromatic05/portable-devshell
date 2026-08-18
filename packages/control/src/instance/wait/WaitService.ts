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
        return await this.#commit("wait.detached", (document) => this.#state.detach(document, waitId));
    }

    async resolve(waitId: string, result?: JsonValue): Promise<WaitRecord> {
        return await this.#commit("wait.resolved", (document) => this.#state.resolve(document, waitId, result));
    }

    async consume(waitId: string): Promise<WaitRecord> {
        return await this.#commit("wait.consumed", (document) => this.#state.consume(document, waitId));
    }

    async cancel(waitId: string): Promise<WaitRecord> {
        return await this.#commit("wait.cancelled", (document) => this.#state.cancel(document, waitId));
    }

    async get(waitId: string): Promise<WaitRecord | undefined> {
        await this.#operation;
        return this.#store.read().waits.find((record) => record.waitId === waitId);
    }

    async list(taskId?: string): Promise<WaitRecord[]> {
        await this.#operation;
        return this.#store.read().waits.filter((record) => taskId === undefined || record.taskId === taskId);
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
        kind: record.kind,
        ...(record.ownerCallId === undefined ? {} : { ownerCallId: record.ownerCallId }),
        status: record.status,
        targetId: record.targetId,
        taskId: record.taskId,
        updatedAt: record.updatedAt,
        waitId: record.waitId,
    };
}
