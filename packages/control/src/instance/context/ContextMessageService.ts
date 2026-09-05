import type {
    ContextMessageListInput,
    ContextMessageQueueInput,
    ContextMessageReadResult,
    ContextMessageRecord,
    InstanceEventType,
    JsonValue,
} from "@portable-devshell/shared";

import { ContextMessageState } from "./ContextMessageState.js";
import { ContextMessageStore } from "./ContextMessageStore.js";

export interface ContextMessageServiceOptions {
    appendEvent(
        type: Extract<InstanceEventType, `context.message.${string}`>,
        data: JsonValue,
    ): Promise<void>;
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
        this.#store = new ContextMessageStore({
            filePath: options.filePath,
            instanceName: options.instanceName,
            state: this.#state,
        });
    }

    async queue(
        input: ContextMessageQueueInput,
    ): Promise<ContextMessageRecord> {
        return await this.#runExclusive(async () => {
            const record = await this.#store.transition((document) => {
                const transition = this.#state.queue(document, this.#instanceName, input);
                return { document: transition.document, result: transition.record };
            });
            try {
                await this.#appendEvent(
                    "context.message.queued",
                    eventData(record),
                );
                return record;
            } catch (error) {
                await this.#markFailed([record], error);
                throw error;
            }
        });
    }

    async list(input: ContextMessageListInput | string = {}): Promise<ContextMessageRecord[]> {
        await this.#operation;
        const query = typeof input === "string" ? { ctxId: input } : input;
        let messages = this.#store.list(query.ctxId);
        if (query.before !== undefined) {
            const index = messages.findIndex((message) => message.id === query.before);
            if (index >= 0) messages = messages.slice(0, index);
        }
        if (query.limit !== undefined) messages = messages.slice(-query.limit);
        if (query.maxBytes === undefined) return messages;
        const accepted: ContextMessageRecord[] = [];
        let bytes = 2;
        for (const message of [...messages].reverse()) {
            const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8") + (accepted.length === 0 ? 0 : 1);
            if (bytes + messageBytes > query.maxBytes) break;
            accepted.unshift(message);
            bytes += messageBytes;
        }
        return accepted;
    }

    async failAllPending(reason: string): Promise<ContextMessageRecord[]> {
        return await this.#runExclusive(async () => {
            const records = this.#store.pending();
            if (records.length === 0) return [];
            await this.#markFailed(records, reason);
            const ids = new Set(records.map((record) => record.id));
            return this.#store.list().filter((message) => ids.has(message.id));
        });
    }

    async failPending(ctxId: string, reason: string): Promise<ContextMessageRecord[]> {
        return await this.#runExclusive(async () => {
            const records = this.#store.pending(ctxId);
            if (records.length === 0) return [];
            await this.#markFailed(records, reason);
            const ids = new Set(records.map((record) => record.id));
            return this.#store.list(ctxId).filter((message) => ids.has(message.id));
        });
    }

    async consumePending(ctxId: string, callId: string): Promise<ContextMessageReadResult> {
        const delivered = await this.#runExclusive(async () => {
            if (this.#store.pending(ctxId).length === 0) return [];
            return await this.#store.transition((document) => {
                const transition = this.#state.deliver(document, ctxId, callId);
                return { document: transition.document, result: transition.delivered };
            });
        });
        const comment = delivered.map((message) => message.text).join("\n\n");
        if (delivered.length > 0) {
            await this.#appendEvent("context.message.delivered", {
                callId,
                comment,
                ctxId,
                deliveredAt: delivered[0]?.deliveredAt ?? new Date().toISOString(),
                ids: delivered.map((message) => message.id),
                status: "delivered",
            }).catch(() => undefined);
        }
        return {
            callId,
            ...(comment.length === 0 ? {} : { comment }),
            messages: delivered.map(({ createdAt, id, text }) => ({ createdAt, id, text })),
        };
    }

    async #markFailed(
        records: readonly ContextMessageRecord[],
        error: unknown,
    ): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        const ids = new Set(records.map((record) => record.id));
        await this.#store.update((document) => this.#state.fail(document, ids, message));
        for (const record of records) {
            await this.#appendEvent("context.message.failed", {
                ...eventData(record),
                error: message,
                status: "failed",
            }).catch(() => undefined);
        }
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

function eventData(record: ContextMessageRecord): Record<string, JsonValue> {
    return {
        ...(record.callId === undefined ? {} : { callId: record.callId }),
        createdAt: record.createdAt,
        ctxId: record.ctxId,
        id: record.id,
        status: record.status,
        text: record.text,
    };
}
