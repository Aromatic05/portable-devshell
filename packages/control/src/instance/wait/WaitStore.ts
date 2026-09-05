import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { createError, errorCodes } from "@portable-devshell/shared";

import { cleanupStaleAtomicStateTemps } from "../AtomicStateFile.js";
import { WaitState, type WaitDocument } from "./WaitState.js";
import type { WaitRecord } from "@portable-devshell/shared";

export class WaitStore {
    readonly #filePath: string;
    readonly #instanceName: string;
    readonly #state: WaitState;
    #document?: WaitDocument;

    constructor(options: { filePath: string; instanceName: string; state: WaitState }) {
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#state = options.state;
    }

    read(): WaitDocument {
        return structuredClone(this.#current());
    }

    readRecord(waitId: string): WaitRecord | undefined {
        const record = this.#current().waits.find((entry) => entry.waitId === waitId);
        return record === undefined ? undefined : structuredClone(record);
    }

    list(taskId?: string): WaitRecord[] {
        return structuredClone(
            this.#current().waits.filter((record) => taskId === undefined || record.taskId === taskId),
        );
    }

    async transition(operation: (document: WaitDocument) => { document: WaitDocument; record: WaitRecord }): Promise<WaitRecord> {
        const next = operation(this.#current());
        await this.#writeAtomic(next.document);
        this.#document = next.document;
        return structuredClone(next.record);
    }

    async write(document: WaitDocument): Promise<WaitDocument> {
        const normalized = this.#state.normalizeDocument(document);
        await this.#writeAtomic(normalized);
        this.#document = normalized;
        return this.read();
    }

    #current(): WaitDocument {
        if (this.#document === undefined) {
            cleanupStaleAtomicStateTemps(this.#filePath);
            this.#document = this.#load();
        }
        return this.#document;
    }

    #load(): WaitDocument {
        if (!existsSync(this.#filePath)) return this.#state.emptyDocument();
        try {
            const document = this.#state.migrateLoadedDocument(
                this.#state.normalizeDocument(JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown),
            );
            const detachedAt = new Date().toISOString();
            return {
                ...document,
                waits: document.waits.map((record) => {
                    if (record.status === "waiting") {
                        return { ...record, detachedAt, status: "detached", updatedAt: detachedAt };
                    }
                    if (record.status === "resolved" && record.detachedAt === undefined) {
                        return { ...record, detachedAt, updatedAt: detachedAt };
                    }
                    return record;
                }),
            };
        } catch (error) {
            throw createError({
                cause: error,
                code: errorCodes.targetInvalid,
                details: { filePath: this.#filePath },
                message: `Wait state for ${this.#instanceName} is invalid.`,
                retryable: false,
            });
        }
    }

    async #writeAtomic(document: WaitDocument): Promise<void> {
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
