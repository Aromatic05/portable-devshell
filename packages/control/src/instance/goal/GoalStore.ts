import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { createError, errorCodes } from "@portable-devshell/shared";

import { GoalState, type GoalDocument } from "./GoalState.js";

export class GoalStore {
    readonly #filePath: string;
    readonly #instanceName: string;
    readonly #state: GoalState;
    #document: GoalDocument;

    constructor(options: { filePath: string; instanceName: string; state: GoalState }) {
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#state = options.state;
        this.#document = this.#load();
    }

    read(): GoalDocument {
        return structuredClone(this.#document);
    }

    async write(document: GoalDocument): Promise<GoalDocument> {
        const normalized = this.#state.normalizeDocument(document);
        await this.#writeAtomic(normalized);
        this.#document = normalized;
        return this.read();
    }

    #load(): GoalDocument {
        if (!existsSync(this.#filePath)) return this.#state.emptyDocument();
        try {
            return this.#state.normalizeDocument(JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown);
        } catch (error) {
            throw createError({
                cause: error,
                code: errorCodes.targetInvalid,
                details: { filePath: this.#filePath },
                message: `Goal state for ${this.#instanceName} is invalid.`,
                retryable: false,
            });
        }
    }

    async #writeAtomic(document: GoalDocument): Promise<void> {
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
