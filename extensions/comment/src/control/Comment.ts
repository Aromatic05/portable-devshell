import type {
    ContextMessageListInput,
    ContextMessageQueueInput,
    ContextMessageReadResult,
    ContextMessageRecord,
    InstanceEventType,
    JsonValue,
} from "@portable-devshell/shared";
import {
    CONTEXT_MESSAGE_PUSH_TOOL_BUDGET,
    createError,
    errorCodes,
    parseContextMessageDirective,
} from "@portable-devshell/shared";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { ConversationStore } from "./Store.js";

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
            "ContextMessageService requires store, conversationFilePath, or filePath.",
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

const MAX_TERMINAL_MESSAGES = 256;

export interface ContextMessageDocument {
    messages: ContextMessageRecord[];
    version: 1;
}

export class ContextMessageState {
    emptyDocument(): ContextMessageDocument {
        return { messages: [], version: 1 };
    }

    normalizeDocument(value: unknown): ContextMessageDocument {
        if (
            !isRecord(value) ||
            value.version !== 1 ||
            !Array.isArray(value.messages)
        ) {
            throw new Error("context message document must be version 1");
        }
        return {
            messages: value.messages.map(normalizeRecord),
            version: 1,
        };
    }

    queue(
        document: ContextMessageDocument,
        instance: string,
        input: ContextMessageQueueInput,
        now = new Date().toISOString(),
    ): { document: ContextMessageDocument; record: ContextMessageRecord } {
        const ctxId = requireText(input.ctxId, "ctxId", 256);
        const text = requireText(input.text, "text", 20_000);
        const record: ContextMessageRecord = {
            createdAt: now,
            ctxId,
            id: `message-${randomUUID()}`,
            instance,
            status: "sent",
            text,
        };
        return {
            document: this.compact({
                ...document,
                messages: [...document.messages, record],
            }),
            record,
        };
    }

    deliver(
        document: ContextMessageDocument,
        ctxId: string,
        callId: string,
        now = new Date().toISOString(),
    ): { delivered: ContextMessageRecord[]; document: ContextMessageDocument } {
        const delivered: ContextMessageRecord[] = [];
        const messages = document.messages.map((message) => {
            if (message.ctxId !== ctxId || message.status !== "sent")
                return message;
            const next = {
                ...message,
                callId,
                deliveredAt: now,
                status: "delivered" as const,
            };
            delivered.push(next);
            return next;
        });
        return { delivered, document: this.compact({ ...document, messages }) };
    }

    fail(
        document: ContextMessageDocument,
        ids: ReadonlySet<string>,
        error: string,
        now = new Date().toISOString(),
    ): ContextMessageDocument {
        return this.compact({
            ...document,
            messages: document.messages.map((message) =>
                ids.has(message.id)
                    ? {
                          ...message,
                          deliveredAt: undefined,
                          error,
                          failedAt: now,
                          status: "failed" as const,
                      }
                    : message,
            ),
        });
    }

    compact(
        document: ContextMessageDocument,
        maxTerminalMessages = MAX_TERMINAL_MESSAGES,
    ): ContextMessageDocument {
        const active = document.messages.filter(
            (message) =>
                message.status === "pending" || message.status === "sent",
        );
        const terminal = document.messages
            .filter(
                (message) =>
                    message.status !== "pending" && message.status !== "sent",
            )
            .sort((left, right) =>
                right.createdAt.localeCompare(left.createdAt),
            )
            .slice(0, Math.max(0, maxTerminalMessages));
        return {
            ...document,
            messages: [...active, ...terminal].sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
            ),
        };
    }
}

function normalizeRecord(value: unknown): ContextMessageRecord {
    if (!isRecord(value)) throw new Error("context message must be an object");
    const status = value.status;
    if (
        status !== "pending" &&
        status !== "sent" &&
        status !== "delivered" &&
        status !== "failed"
    )
        throw new Error("invalid context message status");
    return {
        ...(typeof value.callId === "string" ? { callId: value.callId } : {}),
        createdAt: requireStoredText(value.createdAt, "createdAt"),
        ctxId: requireStoredText(value.ctxId, "ctxId"),
        ...(typeof value.deliveredAt === "string"
            ? { deliveredAt: value.deliveredAt }
            : {}),
        ...(typeof value.error === "string" ? { error: value.error } : {}),
        ...(typeof value.failedAt === "string"
            ? { failedAt: value.failedAt }
            : {}),
        id: requireStoredText(value.id, "id"),
        instance: requireStoredText(value.instance, "instance"),
        status,
        text: requireStoredText(value.text, "text"),
    };
}

function requireText(value: unknown, field: string, maxLength: number): string {
    if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        value.length > maxLength
    ) {
        throw createError({
            code: errorCodes.targetInvalid,
            details: { field, maxLength },
            message: `context message ${field} must be non-empty and at most ${maxLength} characters.`,
            retryable: false,
        });
    }
    return value.trim();
}

function requireStoredText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0)
        throw new Error(`context message ${field} is invalid`);
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
