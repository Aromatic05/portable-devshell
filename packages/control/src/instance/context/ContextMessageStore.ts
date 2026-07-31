import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { createError, errorCodes } from "@portable-devshell/shared";

import { ContextMessageState, type ContextMessageDocument } from "./ContextMessageState.js";

export class ContextMessageStore {
    readonly #filePath: string;
    readonly #instanceName: string;
    readonly #state: ContextMessageState;
    #document: ContextMessageDocument;

    constructor(options: { filePath: string; instanceName: string; state: ContextMessageState }) {
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#state = options.state;
        this.#document = this.#load();
    }

    read(): ContextMessageDocument {
        return structuredClone(this.#document);
    }

    async write(document: ContextMessageDocument): Promise<ContextMessageDocument> {
        const normalized = this.#state.normalizeDocument(document);
        await this.#writeAtomic(normalized);
        this.#document = normalized;
        return this.read();
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
                await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
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
            const fd = openSync(directory, "r");
            try { fsyncSync(fd); } finally { closeSync(fd); }
        }
    }
}
