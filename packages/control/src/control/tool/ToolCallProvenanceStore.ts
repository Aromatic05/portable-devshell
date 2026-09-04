import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { McpToolProvenanceRecord, McpToolProvenanceRecorder } from "@portable-devshell/mcp";
import type { ToolCallRecord } from "@portable-devshell/shared";

const RECORD_VERSION = 1;

interface StoredToolCallProvenance extends McpToolProvenanceRecord {
    recordedAt: string;
    version: typeof RECORD_VERSION;
}

export class ToolCallProvenanceStore implements McpToolProvenanceRecorder {
    readonly #filePath: string;
    readonly #records = new Map<string, StoredToolCallProvenance>();
    #initializePromise?: Promise<void>;
    #mutation: Promise<void> = Promise.resolve();

    constructor(filePath: string) {
        this.#filePath = filePath;
    }

    async record(record: McpToolProvenanceRecord): Promise<void> {
        if (record.purpose === undefined && record.explanation === undefined) return;
        await this.#initialize();
        const operation = this.#mutation.then(async () => {
            const stored: StoredToolCallProvenance = {
                ...record,
                recordedAt: new Date().toISOString(),
                version: RECORD_VERSION
            };
            await mkdir(dirname(this.#filePath), { mode: 0o700, recursive: true });
            await appendFile(this.#filePath, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
            this.#records.set(provenanceKey(record.instance, record.callId), stored);
        });
        this.#mutation = operation.catch(() => undefined);
        await operation;
    }

    async decorate(instance: string, records: readonly ToolCallRecord[]): Promise<ToolCallRecord[]> {
        await this.#initialize();
        return records.map((record) => {
            const provenance = this.#records.get(provenanceKey(instance, record.callId));
            if (provenance === undefined) return record;
            return {
                ...record,
                ...(provenance.explanation === undefined ? {} : { explanation: provenance.explanation }),
                ...(provenance.purpose === undefined ? {} : { purpose: provenance.purpose })
            };
        });
    }

    async #initialize(): Promise<void> {
        this.#initializePromise ??= this.#load();
        await this.#initializePromise;
    }

    async #load(): Promise<void> {
        let source: string;
        try {
            source = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if (isEnoent(error)) return;
            throw error;
        }
        for (const line of source.split("\n")) {
            if (line.length === 0) continue;
            const record = JSON.parse(line) as unknown;
            if (!isStoredRecord(record)) continue;
            this.#records.set(provenanceKey(record.instance, record.callId), record);
        }
    }
}

function provenanceKey(instance: string, callId: string): string {
    return `${instance}\u0000${callId}`;
}

function isStoredRecord(value: unknown): value is StoredToolCallProvenance {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Partial<StoredToolCallProvenance>;
    return record.version === RECORD_VERSION &&
        typeof record.callId === "string" &&
        typeof record.instance === "string" &&
        typeof record.recordedAt === "string" &&
        (record.purpose === undefined || typeof record.purpose === "string") &&
        (record.explanation === undefined || typeof record.explanation === "string");
}

function isEnoent(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
