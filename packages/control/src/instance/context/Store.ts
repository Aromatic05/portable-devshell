import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { createError, errorCodes } from "@portable-devshell/shared";
import type { ContextMessageRecord } from "@portable-devshell/shared";
import { cleanupStaleAtomicStateTemps } from "../AtomicState.js";

export class CommentStore {
    readonly #filePath: string;
    readonly #instanceName: string;
    readonly #state: CommentState;
    #document?: CommentDocument;

    constructor(options: {
        filePath: string;
        instanceName: string;
        state: CommentState;
    }) {
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#state = options.state;
    }

    read(): CommentDocument {
        return structuredClone(this.#current());
    }

    list(ctxId?: string): ContextMessageRecord[] {
        return structuredClone(
            this.#current().messages.filter(
                (message) => ctxId === undefined || message.ctxId === ctxId,
            ),
        );
    }

    pending(ctxId?: string): ContextMessageRecord[] {
        return structuredClone(
            this.#current().messages.filter(
                (message) =>
                    (message.status === "pending" ||
                        message.status === "sent") &&
                    (ctxId === undefined || message.ctxId === ctxId),
            ),
        );
    }

    async transition<T>(
        operation: (document: CommentDocument) => {
            document: CommentDocument;
            result: T;
        },
    ): Promise<T> {
        const next = operation(this.#current());
        await this.#writeAtomic(next.document);
        this.#document = next.document;
        return structuredClone(next.result);
    }

    async update(
        operation: (document: CommentDocument) => CommentDocument,
    ): Promise<void> {
        const next = operation(this.#current());
        await this.#writeAtomic(next);
        this.#document = next;
    }

    async write(
        document: CommentDocument,
    ): Promise<CommentDocument> {
        const normalized = this.#state.normalizeDocument(document);
        await this.#writeAtomic(normalized);
        this.#document = normalized;
        return this.read();
    }

    #current(): CommentDocument {
        if (this.#document === undefined) {
            cleanupStaleAtomicStateTemps(this.#filePath);
            this.#document = this.#load();
        }
        return this.#document;
    }

    #load(): CommentDocument {
        if (!existsSync(this.#filePath)) return this.#state.emptyDocument();
        try {
            return this.#state.normalizeDocument(
                JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown,
            );
        } catch (error) {
            throw createError({
                cause: error,
                code: errorCodes.targetInvalid,
                details: { filePath: this.#filePath },
                message: `Context message state for ${this.#instanceName} is invalid.`,
                retryable: false,
            });
        }
    }

    async #writeAtomic(document: CommentDocument): Promise<void> {
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
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
        }
    }
}


export { CommentState, type CommentDocument } from "@portable-devshell/comment-extension";
import { CommentState, type CommentDocument } from "@portable-devshell/comment-extension";
