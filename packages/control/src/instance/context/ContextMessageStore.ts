import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { createError, errorCodes, type ContextMessageRecord } from "@portable-devshell/shared";

import { cleanupStaleAtomicStateTemps } from "../AtomicStateFile.js";
import { ContextMessageState, type ContextMessageDocument } from "./ContextMessageState.js";

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
