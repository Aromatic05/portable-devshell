import type {
    ContextMessageListInput,
    ContextMessageQueueInput,
    ContextMessageReadResult,
    ContextMessageRecord,
    InstanceEventType,
    JsonValue,
    PrefixRouteModuleDefinition,
} from "@portable-devshell/shared";
import {
    CONTEXT_MESSAGE_PUSH_TOOL_BUDGET,
    createError,
    errorCodes,
    parseContextMessageDirective,
} from "@portable-devshell/shared";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { ConversationStore } from "../conversation/store/ConversationStore.js";
import { CommentState } from "./CommentState.js";

export interface CommentServiceOptions {
    appendEvent(
        type: Extract<InstanceEventType, `context.message.${string}`>,
        data: JsonValue,
    ): Promise<void>;
    conversationFilePath?: string;
    filePath?: string;
    instanceName: string;
    store?: ConversationStore;
}

export class CommentService {
    readonly #appendEvent: CommentServiceOptions["appendEvent"];
    readonly #instanceName: string;
    readonly #state = new CommentState();
    readonly #store: ConversationStore;
    #operation: Promise<void> = Promise.resolve();

    constructor(options: CommentServiceOptions) {
        this.#appendEvent = options.appendEvent;
        this.#instanceName = options.instanceName;
        this.#store =
            options.store ??
            new ConversationStore({
                filePath:
                    options.conversationFilePath ??
                    defaultConversationFile(options.filePath),
                instanceName: options.instanceName,
                ...(options.filePath === undefined
                    ? {}
                    : { legacyContextMessagesFile: options.filePath }),
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

    async list(
        input: ContextMessageListInput | string = {},
    ): Promise<ContextMessageRecord[]> {
        await this.#operation;
        const query = typeof input === "string" ? { ctxId: input } : input;
        return this.#store.listComments(query);
    }

    async reviewToolCall(
        ctxId: string,
        toolName: string,
        requestId?: string,
    ): Promise<
        | { kind: "allow" }
        | { commentId: string; kind: "push"; toolCallBudget: number }
        | { comment: string; commentId: string; kind: "resume" }
        | { comment?: string; commentId: string; kind: "stop" }
    > {
        return await this.#runExclusive(async () => {
            let state = this.#store.readControlState(ctxId);
            if (state.stoppedByCommentId !== undefined) {
                const stoppedByCommentId = state.stoppedByCommentId;
                const pending = this.#store.pendingComments(ctxId);
                if (pending.length > 0) {
                    const delivered = this.#store.deliverComments(
                        ctxId,
                        requestId ?? `control-message-${randomUUID()}`,
                        new Date().toISOString(),
                    );
                    await this.#recordDelivered(delivered);
                    state = this.#store.readControlState(ctxId);
                    const comment = delivered
                        .map((record) => record.text)
                        .join("\n\n");
                    if (state.stoppedByCommentId !== undefined) {
                        return {
                            ...(comment.length === 0 ? {} : { comment }),
                            commentId: state.stoppedByCommentId,
                            kind: "stop",
                        };
                    }
                    const resume = [...delivered]
                        .reverse()
                        .find(
                            (record) =>
                                parseContextMessageDirective(record.text)
                                    .directive === "resume",
                        );
                    if (resume !== undefined) {
                        return {
                            comment,
                            commentId: resume.id,
                            kind: "resume",
                        };
                    }
                    throw new Error(
                        "Conversation Stop state cleared without a delivered #resume Comment.",
                    );
                }
                return { commentId: stoppedByCommentId, kind: "stop" };
            }
            if (
                toolName === "todo_report" ||
                state.pendingPushCommentId === undefined
            ) {
                return { kind: "allow" };
            }
            const remaining =
                state.pushToolCallsRemaining ??
                CONTEXT_MESSAGE_PUSH_TOOL_BUDGET;
            if (remaining <= 0) {
                return {
                    commentId: state.pendingPushCommentId,
                    kind: "push",
                    toolCallBudget: CONTEXT_MESSAGE_PUSH_TOOL_BUDGET,
                };
            }
            state.pushToolCallsRemaining = remaining - 1;
            this.#store.writeControlState(ctxId, state);
            return { kind: "allow" };
        });
    }

    async pendingReplyCommentId(ctxId: string): Promise<string | undefined> {
        return await this.#runExclusive(
            async () =>
                this.#store.readControlState(ctxId).pendingReplyCommentId,
        );
    }

    async failAllPending(reason: string): Promise<ContextMessageRecord[]> {
        return await this.#runExclusive(async () => {
            const records = this.#store.pendingComments();
            if (records.length > 0) await this.#markFailed(records, reason);
            this.#store.clearAllControlStates();
            if (records.length === 0) return [];
            const ids = new Set(records.map((record) => record.id));
            return this.#store
                .listComments()
                .filter((message) => ids.has(message.id));
        });
    }

    async failPending(
        ctxId: string,
        reason: string,
    ): Promise<ContextMessageRecord[]> {
        return await this.#runExclusive(async () => {
            const records = this.#store.pendingComments(ctxId);
            if (records.length > 0) await this.#markFailed(records, reason);
            this.#store.writeControlState(ctxId, {});
            if (records.length === 0) return [];
            const ids = new Set(records.map((record) => record.id));
            return this.#store
                .listComments({ ctxId })
                .filter((message) => ids.has(message.id));
        });
    }

    async consumePending(
        ctxId: string,
        callId: string,
    ): Promise<ContextMessageReadResult> {
        const delivered = await this.#runExclusive(async () => {
            if (this.#store.pendingComments(ctxId).length === 0) return [];
            return this.#store.deliverComments(
                ctxId,
                callId,
                new Date().toISOString(),
            );
        });
        const comment = delivered.map((message) => message.text).join("\n\n");
        if (delivered.length > 0) {
            await this.#appendEvent("context.message.delivered", {
                callId,
                comment,
                ctxId,
                deliveredAt:
                    delivered[0]?.deliveredAt ?? new Date().toISOString(),
                ids: delivered.map((message) => message.id),
                status: "delivered",
            }).catch(() => undefined);
        }
        return {
            callId,
            ...(comment.length === 0 ? {} : { comment }),
            messages: delivered.map(({ createdAt, id, text }) => ({
                createdAt,
                id,
                text,
            })),
        };
    }

    async #recordDelivered(
        records: readonly ContextMessageRecord[],
    ): Promise<void> {
        if (records.length === 0) return;
        const first = records[0]!;
        await this.#appendEvent("context.message.delivered", {
            callId: first.callId ?? "control-message",
            comment: records.map((record) => record.text).join("\n\n"),
            ctxId: first.ctxId,
            deliveredAt: first.deliveredAt ?? new Date().toISOString(),
            ids: records.map((record) => record.id),
            status: "delivered",
        }).catch(() => undefined);
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
        throw new Error(
            "CommentService requires store, conversationFilePath, or filePath.",
        );
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

export function createCommentRouteModule(
    service: Pick<CommentService, "list" | "queue">,
): PrefixRouteModuleDefinition {
    return {
        name: "contextMessage",
        operations: [
            {
                name: "list",
                handle: async (request) =>
                    (await service.list(
                        readCommentListInput(request.payload ?? {}),
                    )) as unknown as JsonValue,
            },
            {
                name: "queue",
                handle: async (request) =>
                    (await service.queue(
                        readCommentQueueInput(request.payload ?? {}),
                    )) as unknown as JsonValue,
            },
        ],
    };
}

function readCommentQueueInput(value: JsonValue): ContextMessageQueueInput {
    if (
        !isRecord(value) ||
        typeof value.ctxId !== "string" ||
        typeof value.text !== "string" ||
        Object.keys(value).some((key) => key !== "ctxId" && key !== "text")
    ) {
        throw invalidRouteInput(
            "contextMessage.queue requires only ctxId and text strings.",
        );
    }
    return { ctxId: value.ctxId, text: value.text };
}

function readCommentListInput(value: JsonValue): ContextMessageListInput {
    if (
        !isRecord(value) ||
        Object.keys(value).some(
            (key) => !["before", "ctxId", "limit", "maxBytes"].includes(key),
        )
    ) {
        throw invalidRouteInput(
            "contextMessage.list accepts only before, ctxId, limit, and maxBytes.",
        );
    }
    if (value.before !== undefined && typeof value.before !== "string")
        throw invalidRouteInput("contextMessage.list before must be a string.");
    if (value.ctxId !== undefined && typeof value.ctxId !== "string")
        throw invalidRouteInput("contextMessage.list ctxId must be a string.");
    if (
        value.limit !== undefined &&
        (typeof value.limit !== "number" || !Number.isSafeInteger(value.limit))
    )
        throw invalidRouteInput("contextMessage.list limit must be an integer.");
    if (
        value.maxBytes !== undefined &&
        (typeof value.maxBytes !== "number" ||
            !Number.isSafeInteger(value.maxBytes))
    )
        throw invalidRouteInput("contextMessage.list maxBytes must be an integer.");
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
    return createError({
        code: errorCodes.targetInvalid,
        message,
        retryable: false,
    });
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
