import { randomUUID } from "node:crypto";

import {
    createError,
    errorCodes,
    type ContextMessageQueueInput,
    type ContextMessageRecord,
} from "@portable-devshell/shared";

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
