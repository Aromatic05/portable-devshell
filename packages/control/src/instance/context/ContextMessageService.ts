import type {
    ContextMessageQueueInput,
    ContextMessageReadResult,
    ContextMessageRecord,
    InstanceEventType,
    JsonValue
} from "@portable-devshell/shared";

import { ContextMessageState } from "./ContextMessageState.js";
import { ContextMessageStore } from "./ContextMessageStore.js";

export interface ContextMessageServiceOptions {
    appendEvent(type: Extract<InstanceEventType, `context.message.${string}`>, data: JsonValue): Promise<void>;
    filePath: string;
    instanceName: string;
}

export class ContextMessageService {
    readonly #appendEvent: ContextMessageServiceOptions["appendEvent"];
    readonly #instanceName: string;
    readonly #state = new ContextMessageState();
    readonly #store: ContextMessageStore;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: ContextMessageServiceOptions) {
        this.#appendEvent = options.appendEvent;
        this.#instanceName = options.instanceName;
        this.#store = new ContextMessageStore({ filePath: options.filePath, instanceName: options.instanceName, state: this.#state });
    }

    async queue(input: ContextMessageQueueInput): Promise<ContextMessageRecord> {
        return await this.#runExclusive(async () => {
            const transition = this.#state.queue(this.#store.read(), this.#instanceName, input);
            await this.#store.write(transition.document);
            try {
                await this.#appendEvent("context.message.queued", eventData(transition.record));
                return transition.record;
            } catch (error) {
                await this.#markFailed([transition.record], error);
                throw error;
            }
        });
    }

    async list(ctxId?: string): Promise<ContextMessageRecord[]> {
        await this.#operation;
        return this.#store.read().messages.filter((message) => ctxId === undefined || message.ctxId === ctxId);
    }

    async readPending(ctxId: string): Promise<ContextMessageReadResult> {
        return await this.#runExclusive(async () => {
            const transition = this.#state.deliver(this.#store.read(), ctxId);
            if (transition.delivered.length === 0) return { messages: [] };
            await this.#store.write(transition.document);
            try {
                for (const message of transition.delivered) {
                    await this.#appendEvent("context.message.delivered", eventData(message));
                }
            } catch (error) {
                await this.#markFailed(transition.delivered, error);
                throw error;
            }
            return {
                messages: transition.delivered.map(({ createdAt, id, text }) => ({ createdAt, id, text }))
            };
        });
    }

    async #markFailed(records: readonly ContextMessageRecord[], error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        const ids = new Set(records.map((record) => record.id));
        const failed = this.#state.fail(this.#store.read(), ids, message);
        await this.#store.write(failed);
        for (const record of records) {
            await this.#appendEvent("context.message.failed", {
                ...eventData(record),
                error: message,
                status: "failed"
            }).catch(() => undefined);
        }
    }

    async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#operation;
        let release!: () => void;
        this.#operation = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await operation(); } finally { release(); }
    }
}

function eventData(record: ContextMessageRecord): Record<string, JsonValue> {
    return {
        createdAt: record.createdAt,
        ctxId: record.ctxId,
        id: record.id,
        status: record.status,
        text: record.text
    };
}
