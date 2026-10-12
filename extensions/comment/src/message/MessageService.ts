import { ExtensionError } from "@portable-devshell/extension";
import type {
    MessageEntry,
    MessageListInput,
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";

import { MessageStore } from "./store/MessageStore.js";

export class MessageService {
    readonly #instanceName: string;
    readonly #store: MessageStore;
    #operation: Promise<void> = Promise.resolve();
    #retired = false;
    #retirement?: Promise<void>;

    constructor(options: { instanceName: string; store: MessageStore }) {
        this.#instanceName = options.instanceName;
        this.#store = options.store;
    }

    async list(input: MessageListInput = {}): Promise<MessageEntry[]> {
        return await this.#runExclusive(
            async () => await this.#store.list(input),
        );
    }

    async recordReport(input: {
        callId: string;
        createdAt?: string;
        ctxId: string;
        push?: { commentId: string; message: string };
        replyCommentId?: string;
        text: string;
    }): Promise<void> {
        await this.#runExclusive(async () => {
            await this.#store.appendReport({
                callId: input.callId,
                createdAt: input.createdAt ?? new Date().toISOString(),
                ctxId: input.ctxId,
                ...(input.push === undefined ? {} : { push: input.push }),
                ...(input.replyCommentId === undefined
                    ? {}
                    : { replyCommentId: input.replyCommentId }),
                text: input.text,
            });
        });
    }

    retire(): Promise<void> {
        if (this.#retirement !== undefined) return this.#retirement;
        this.#retired = true;
        this.#retirement = this.#runExclusive(async () => undefined, true);
        return this.#retirement;
    }

    async close(): Promise<void> {
        await this.#store.close();
    }

    async #runExclusive<T>(
        operation: () => Promise<T>,
        allowRetired = false,
    ): Promise<T> {
        if (this.#retired && !allowRetired)
            throw retiredMessageService(this.#instanceName);
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

function retiredMessageService(instance: string): Error {
    return new ExtensionError({
        code: "control.instanceNotFound",
        details: { instance },
        message: `Instance ${instance} was not found or is disabled.`,
        retryable: false,
    });
}

export function createMessageHistoryRouteModule(
    service: Pick<MessageService, "list">,
): ControlPortDefinition {
    return {
        name: "message",
        operations: [
            {
                name: "listMessageEntries",
                handle: async (request) =>
                    (await service.list(
                        readMessageListInput(request.payload ?? {}),
                    )) as unknown as JsonValue,
            },
        ],
    };
}

function readMessageListInput(value: JsonValue): MessageListInput {
    if (
        !isRecord(value) ||
        Object.keys(value).some(
            (key) => !["before", "ctxId", "limit", "maxBytes"].includes(key),
        )
    )
        throw invalidRouteInput(
            "message.listMessageEntries accepts only before, ctxId, limit, and maxBytes.",
        );
    if (value.before !== undefined && typeof value.before !== "string")
        throw invalidRouteInput(
            "message.listMessageEntries before must be a string.",
        );
    if (value.ctxId !== undefined && typeof value.ctxId !== "string")
        throw invalidRouteInput(
            "message.listMessageEntries ctxId must be a string.",
        );
    if (
        value.limit !== undefined &&
        (typeof value.limit !== "number" || !Number.isSafeInteger(value.limit))
    )
        throw invalidRouteInput(
            "message.listMessageEntries limit must be an integer.",
        );
    if (
        value.maxBytes !== undefined &&
        (typeof value.maxBytes !== "number" ||
            !Number.isSafeInteger(value.maxBytes))
    )
        throw invalidRouteInput(
            "message.listMessageEntries maxBytes must be an integer.",
        );
    return {
        ...(value.before === undefined ? {} : { before: value.before }),
        ...(value.ctxId === undefined ? {} : { ctxId: value.ctxId }),
        ...(value.limit === undefined
            ? {}
            : { limit: Math.min(Math.max(value.limit, 1), 1_000) }),
        ...(value.maxBytes === undefined
            ? {}
            : { maxBytes: Math.min(Math.max(value.maxBytes, 1), 1024 * 1024) }),
    };
}

function invalidRouteInput(message: string): Error {
    return new ExtensionError({
        code: "control.invalidTarget",
        message,
        retryable: false,
    });
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
