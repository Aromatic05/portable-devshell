import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { createError, errorCodes } from "@portable-devshell/shared";
import type { ContextMessageQueueInput, ContextMessageRecord } from "@portable-devshell/shared";
import { cleanupStaleAtomicStateTemps } from "../AtomicState.js";

export class ContextMessageStore {
    readonly #filePath: string;
    readonly #instanceName: string;
    readonly #state: ContextMessageState;
    #document?: ContextMessageDocument;

    constructor(options: { filePath: string; instanceName: string; state: ContextMessageState }) {
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#state = options.state;
    }

    read(): ContextMessageDocument {
        return structuredClone(this.#current());
    }

    list(ctxId?: string): ContextMessageRecord[] {
        return structuredClone(
            this.#current().messages.filter((message) => ctxId === undefined || message.ctxId === ctxId),
        );
    }

    pending(ctxId?: string): ContextMessageRecord[] {
        return structuredClone(
            this.#current().messages.filter((message) =>
                (message.status === "pending" || message.status === "sent") &&
                (ctxId === undefined || message.ctxId === ctxId)
            ),
        );
    }

    async transition<T>(
        operation: (document: ContextMessageDocument) => { document: ContextMessageDocument; result: T },
    ): Promise<T> {
        const next = operation(this.#current());
        await this.#writeAtomic(next.document);
        this.#document = next.document;
        return structuredClone(next.result);
    }

    async update(operation: (document: ContextMessageDocument) => ContextMessageDocument): Promise<void> {
        const next = operation(this.#current());
        await this.#writeAtomic(next);
        this.#document = next;
    }

    async write(document: ContextMessageDocument): Promise<ContextMessageDocument> {
        const normalized = this.#state.normalizeDocument(document);
        await this.#writeAtomic(normalized);
        this.#document = normalized;
        return this.read();
    }

    #current(): ContextMessageDocument {
        if (this.#document === undefined) {
            cleanupStaleAtomicStateTemps(this.#filePath);
            this.#document = this.#load();
        }
        return this.#document;
    }

    #load(): ContextMessageDocument {
        if (!existsSync(this.#filePath)) return this.#state.emptyDocument();
        try {
            return this.#state.normalizeDocument(JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown);
        } catch (error) {
            throw createError({
                cause: error,
                code: errorCodes.targetInvalid,
                details: { filePath: this.#filePath },
                message: `Context message state for ${this.#instanceName} is invalid.`,
                retryable: false
            });
        }
    }

    async #writeAtomic(document: ContextMessageDocument): Promise<void> {
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary = `${this.#filePath}.tmp.${process.pid}.${randomUUID()}`;
        try {
            const handle = await open(temporary, "wx", 0o600);
            try {
                await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
            await rename(temporary, this.#filePath);
        } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
        if (process.platform !== "win32") {
            const handle = await open(directory, "r");
            try { await handle.sync(); } finally { await handle.close(); }
        }
    }
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
