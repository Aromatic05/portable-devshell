import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
    createEmptyConversationPreferences,
    type ConversationPreferencesPatch,
    type ConversationPreferencesSnapshot,
} from "@portable-devshell/shared";

import {
    applyPatch,
    clonePreferences,
    parseConversationPreferencesPatch,
    parseConversationPreferencesSnapshot,
    samePreferences,
} from "./Model.js";

export class ConversationPreferenceStore {
    readonly #filePath: string;
    #operationQueue = Promise.resolve();

    constructor(filePath: string) {
        this.#filePath = filePath;
    }

    async read(): Promise<ConversationPreferencesSnapshot> {
        return await this.#exclusive(async () => await this.#read());
    }

    async update(
        patch: ConversationPreferencesPatch,
    ): Promise<ConversationPreferencesSnapshot> {
        const normalized = parseConversationPreferencesPatch(patch);
        return await this.#exclusive(async () => {
            const current = await this.#read();
            const next = applyPatch(current, normalized);
            if (samePreferences(current, next)) return current;
            await this.#write(next);
            return clonePreferences(next);
        });
    }

    async #read(): Promise<ConversationPreferencesSnapshot> {
        const source = await readFile(this.#filePath, "utf8").catch(
            (error: unknown) => {
                if (isMissing(error)) return undefined;
                throw error;
            },
        );
        if (source === undefined) return createEmptyConversationPreferences();
        return parseConversationPreferencesSnapshot(
            JSON.parse(source) as unknown,
        );
    }

    async #write(snapshot: ConversationPreferencesSnapshot): Promise<void> {
        const validated = parseConversationPreferencesSnapshot(snapshot);
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(
                `${JSON.stringify(validated, null, 2)}\n`,
                "utf8",
            );
            await handle.sync();
        } catch (error) {
            await handle.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
        await handle.close();
        try {
            await rename(temporary, this.#filePath);
            if (process.platform !== "win32") {
                const directoryHandle = await open(directory, "r");
                try {
                    await directoryHandle.sync();
                } finally {
                    await directoryHandle.close();
                }
            }
        } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.#operationQueue.then(operation, operation);
        this.#operationQueue = next.then(
            () => undefined,
            () => undefined,
        );
        return await next;
    }
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}
