import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { createError, errorCodes } from "@portable-devshell/shared";

import { cleanupStaleAtomicStateTemps } from "../AtomicStateFile.js";
import { TodoState, type TodoDocument } from "./TodoState.js";

export interface TodoStoreOptions {
    filePath: string;
    instanceName: string;
    state: TodoState;
}

export class TodoStore {
    readonly #filePath: string;
    readonly #instanceName: string;
    readonly #state: TodoState;
    #document?: TodoDocument;

    constructor(options: TodoStoreOptions) {
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#state = options.state;
    }

    get filePath(): string {
        return this.#filePath;
    }

    exists(): boolean {
        return existsSync(this.#filePath);
    }

    read(): TodoDocument {
        return structuredClone(this.#current());
    }

    readActive(): TodoDocument {
        return { active: structuredClone(this.#current().active), archived: [], version: 4 };
    }

    reload(): TodoDocument {
        this.#document = this.#loadFromDisk();
        return this.read();
    }

    async write(document: TodoDocument): Promise<TodoDocument> {
        const normalized = this.#state.normalizeDocument(document);
        await this.#writeAtomic(normalized);
        this.#document = normalized;
        return this.read();
    }

    async update(
        operation: (document: TodoDocument) => TodoDocument | Promise<TodoDocument>
    ): Promise<TodoDocument> {
        const next = await operation(this.read());
        return await this.write(next);
    }

    async transition<T>(
        operation: (document: TodoDocument) => { document: TodoDocument; result: T }
    ): Promise<T> {
        const current = this.#current();
        const next = operation(current);
        if (next.document !== current) {
            await this.#writeAtomic(next.document);
            this.#document = next.document;
        }
        return structuredClone(next.result);
    }

    #current(): TodoDocument {
        if (this.#document === undefined) {
            cleanupStaleAtomicStateTemps(this.#filePath);
            this.#document = this.#loadFromDisk();
        }
        return this.#document;
    }

    #loadFromDisk(): TodoDocument {
        if (!existsSync(this.#filePath)) {
            return this.#state.emptyDocument();
        }

        try {
            const value = JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown;
            return this.#state.normalizeDocument(value);
        } catch (error) {
            throw createError({
                cause: error,
                code: errorCodes.todoInvalid,
                details: { filePath: this.#filePath },
                message: `Todo state for ${this.#instanceName} is invalid.`,
                retryable: false
            });
        }
    }

    async #writeAtomic(document: TodoDocument): Promise<void> {
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary = `${this.#filePath}.tmp.${process.pid}.${randomUUID()}`;

        try {
            const handle = await open(temporary, "wx", 0o600);
            try {
                await handle.writeFile(
                    `${JSON.stringify(document)}\n`,
                    "utf8"
                );
                await handle.sync();
            } finally {
                await handle.close();
            }
            await rename(temporary, this.#filePath);
        } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }

        await this.#syncDirectory(directory);
    }

    async #syncDirectory(directory: string): Promise<void> {
        if (process.platform === "win32") {
            return;
        }
        const handle = await open(directory, "r");
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
}
