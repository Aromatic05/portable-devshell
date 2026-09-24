import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
    normalizeConfigInstanceDraft,
    parseConfigInstanceDraft,
    toConfigInstanceDraft,
    type ControlConfig,
} from "@portable-devshell/shared";

export interface InstanceCleanupDebtRecord {
    instance: ControlConfig["instances"][number];
    operation: "delete" | "disable" | "rebuild";
    skipRuntimeRetirement?: boolean;
}

export class InstanceCleanupDebtStore {
    readonly #filePath?: string;
    readonly #records = new Map<string, InstanceCleanupDebtRecord>();
    #loaded = false;
    #tail = Promise.resolve();

    constructor(filePath?: string) {
        this.#filePath = filePath;
    }

    async get(instance: string): Promise<InstanceCleanupDebtRecord | undefined> {
        return await this.#exclusive(async () => this.#records.get(instance));
    }

    async list(): Promise<InstanceCleanupDebtRecord[]> {
        return await this.#exclusive(async () => [...this.#records.values()]);
    }

    async put(record: InstanceCleanupDebtRecord): Promise<void> {
        await this.#exclusive(async () => {
            const previous = this.#records.get(record.instance.name);
            this.#records.set(record.instance.name, record);
            try {
                await this.#persist();
            } catch (error) {
                if (previous === undefined)
                    this.#records.delete(record.instance.name);
                else this.#records.set(record.instance.name, previous);
                throw error;
            }
        });
    }

    async clear(instance: string): Promise<void> {
        await this.#exclusive(async () => {
            const previous = this.#records.get(instance);
            if (previous === undefined) return;
            this.#records.delete(instance);
            try {
                await this.#persist();
            } catch (error) {
                this.#records.set(instance, previous);
                throw error;
            }
        });
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#tail;
        let release!: () => void;
        this.#tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            await this.#load();
            return await operation();
        } finally {
            release();
        }
    }

    async #load(): Promise<void> {
        if (this.#loaded) return;
        this.#loaded = true;
        if (this.#filePath === undefined) return;
        let source: string;
        try {
            source = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            this.#loaded = false;
            throw error;
        }
        try {
            const parsed = JSON.parse(source) as unknown;
            if (!Array.isArray(parsed)) {
                throw new Error(
                    `Invalid lifecycle cleanup state: ${this.#filePath}.`,
                );
            }
            this.#records.clear();
            for (const value of parsed) {
                const record = parseCleanupDebtRecord(value);
                this.#records.set(record.instance.name, record);
            }
        } catch (error) {
            this.#records.clear();
            this.#loaded = false;
            throw error;
        }
    }

    async #persist(): Promise<void> {
        if (this.#filePath === undefined) return;
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
            const persisted = [...this.#records.values()].map((record) => ({
                ...record,
                instance: toConfigInstanceDraft(record.instance),
            }));
            await file.writeFile(`${JSON.stringify(persisted)}\n`, "utf8");
            await file.sync();
        } catch (error) {
            await file.close().catch(() => undefined);
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
        await file.close();
        try {
            await rename(temporary, this.#filePath);
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
        if (process.platform !== "win32") {
            const parent = await open(directory, "r");
            try {
                await parent.sync();
            } finally {
                await parent.close();
            }
        }
    }
}

function parseCleanupDebtRecord(value: unknown): InstanceCleanupDebtRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Invalid lifecycle cleanup record.");
    }
    const record = value as Record<string, unknown>;
    if (
        record.operation !== "delete" &&
        record.operation !== "disable" &&
        record.operation !== "rebuild"
    ) {
        throw new Error("Invalid lifecycle cleanup operation.");
    }
    const instance = normalizeConfigInstanceDraft(
        parseConfigInstanceDraft(record.instance, ["instance"]),
    );
    if (
        record.skipRuntimeRetirement !== undefined &&
        typeof record.skipRuntimeRetirement !== "boolean"
    ) {
        throw new Error("Invalid lifecycle cleanup retirement flag.");
    }
    return {
        instance,
        operation: record.operation,
        ...(record.skipRuntimeRetirement === undefined
            ? {}
            : {
                  skipRuntimeRetirement: record.skipRuntimeRetirement,
              }),
    };
}
