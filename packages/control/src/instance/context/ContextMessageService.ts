import type {
    ContextMessageListInput,
    ContextMessageQueueInput,
    ContextMessageReadResult,
    ContextMessageRecord,
    InstanceEventType,
    JsonValue,
} from "@portable-devshell/shared";
import { dirname, join } from "node:path";

import { ContextMessageState } from "./ContextMessageState.js";
import { ConversationStore } from "../conversation/ConversationStore.js";

export interface ContextMessageServiceOptions {
    appendEvent(
        type: Extract<InstanceEventType, `context.message.${string}`>,
        data: JsonValue,
    ): Promise<void>;
    conversationFilePath?: string;
    filePath?: string;
    instanceName: string;
    store?: ConversationStore;
}

export class ContextMessageService {
    readonly #appendEvent: ContextMessageServiceOptions["appendEvent"];
    readonly #instanceName: string;
    readonly #state = new ContextMessageState();
    readonly #store: ConversationStore;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: ContextMessageServiceOptions) {
        this.#appendEvent = options.appendEvent;
        this.#instanceName = options.instanceName;
        this.#store = options.store ?? new ConversationStore({
            filePath: options.conversationFilePath ?? defaultConversationFile(options.filePath),
            instanceName: options.instanceName,
            ...(options.filePath === undefined ? {} : { legacyContextMessagesFile: options.filePath }),
        });
    }

    async queue(
        input: ContextMessageQueueInput,
    ): Promise<ContextMessageRecord> {
        return await this.#runExclusive(async () => {
            const record = this.#state.queue(
                this.#state.emptyDocument(),
                this.#instanceName,
                input,
            ).record;
            this.#store.insertComment(record);
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
        return this.#store.listComments(query);
    }

    async failAllPending(reason: string): Promise<ContextMessageRecord[]> {
        return await this.#runExclusive(async () => {
            const records = this.#store.pendingComments();
            if (records.length === 0) return [];
            await this.#markFailed(records, reason);
            const ids = new Set(records.map((record) => record.id));
            return this.#store.listComments().filter((message) => ids.has(message.id));
        });
    }

    async failPending(ctxId: string, reason: string): Promise<ContextMessageRecord[]> {
        return await this.#runExclusive(async () => {
            const records = this.#store.pendingComments(ctxId);
            if (records.length === 0) return [];
            await this.#markFailed(records, reason);
            const ids = new Set(records.map((record) => record.id));
            return this.#store.listComments({ ctxId }).filter((message) => ids.has(message.id));
        });
    }

    async consumePending(ctxId: string, callId: string): Promise<ContextMessageReadResult> {
        const delivered = await this.#runExclusive(async () => {
            if (this.#store.pendingComments(ctxId).length === 0) return [];
            return this.#store.deliverComments(ctxId, callId, new Date().toISOString());
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
        this.#store.failComments(ids, message, new Date().toISOString());
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

function defaultConversationFile(legacyFilePath: string | undefined): string {
    if (legacyFilePath === undefined) {
        throw new Error("ContextMessageService requires store, conversationFilePath, or filePath.");
    }
    return join(dirname(legacyFilePath), "conversation.sqlite3");
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
