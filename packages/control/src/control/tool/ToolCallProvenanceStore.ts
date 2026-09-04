import { appendFile, mkdir, readFile, stat, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { McpToolProvenanceRecord, McpToolProvenanceRecorder } from "@portable-devshell/mcp";
import type { ToolCallRecord } from "@portable-devshell/shared";

import {
    parseRecords,
    provenanceKey,
    serializeRecords,
    ToolCallProvenanceArchive,
    type StoredToolCallProvenance
} from "./ToolCallProvenanceArchive.js";

const RECORD_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_COLD_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;

export interface ToolCallProvenanceStoreOptions {
    coldMaxBytes?: number;
    hotMaxBytes?: number;
    now?: () => number;
    retentionDays?: number;
}

export class ToolCallProvenanceStore implements McpToolProvenanceRecorder {
    readonly #archive: ToolCallProvenanceArchive;
    readonly #filePath: string;
    readonly #hotMaxBytes: number;
    readonly #hotRecords = new Map<string, StoredToolCallProvenance>();
    readonly #now: () => number;
    readonly #retentionMs: number;
    #initializePromise?: Promise<void>;
    #mutation: Promise<void> = Promise.resolve();

    constructor(filePath: string, options: ToolCallProvenanceStoreOptions = {}) {
        this.#filePath = filePath;
        this.#hotMaxBytes = positiveInteger(options.hotMaxBytes ?? DEFAULT_HOT_MAX_BYTES, "hotMaxBytes");
        const coldMaxBytes = positiveInteger(options.coldMaxBytes ?? DEFAULT_COLD_MAX_BYTES, "coldMaxBytes");
        const retentionDays = positiveInteger(options.retentionDays ?? DEFAULT_RETENTION_DAYS, "retentionDays");
        this.#now = options.now ?? Date.now;
        this.#retentionMs = retentionDays * DAY_MS;
        this.#archive = new ToolCallProvenanceArchive({
            archiveDirectory: `${filePath}.archive`,
            coldMaxBytes,
            now: this.#now,
            retentionMs: this.#retentionMs
        });
    }

    async warmup(): Promise<void> {
        await this.#initialize();
    }

    async record(record: McpToolProvenanceRecord): Promise<void> {
        if (record.purpose === undefined && record.explanation === undefined) return;
        await this.#initialize();
        const operation = this.#mutation.then(async () => {
            await this.#pruneHotRetention();
            const stored: StoredToolCallProvenance = {
                ...record,
                recordedAt: new Date(this.#now()).toISOString(),
                version: RECORD_VERSION
            };
            await mkdir(dirname(this.#filePath), { mode: 0o700, recursive: true });
            await appendFile(this.#filePath, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
            this.#hotRecords.set(provenanceKey(record.instance, record.callId), stored);
            await this.#rotateIfNeeded();
        });
        this.#mutation = operation.catch(() => undefined);
        await operation;
    }

    async decorate(instance: string, records: readonly ToolCallRecord[]): Promise<ToolCallRecord[]> {
        await this.#initialize();
        const operation = this.#mutation.then(async () => {
            const cutoff = this.#now() - this.#retentionMs;
            const keys = records.map((record) => provenanceKey(instance, record.callId));
            const hot = new Map<string, StoredToolCallProvenance>();
            for (const key of keys) {
                const provenance = this.#hotRecords.get(key);
                if (provenance !== undefined && Date.parse(provenance.recordedAt) >= cutoff) {
                    hot.set(key, provenance);
                }
            }
            const missing = keys.filter((key) => !hot.has(key));
            const cold = missing.length === 0 ? new Map() : await this.#archive.lookup(missing);
            return records.map((record) => {
                const key = provenanceKey(instance, record.callId);
                const provenance = hot.get(key) ?? cold.get(key);
                if (provenance === undefined) return record;
                return {
                    ...record,
                    ...(provenance.explanation === undefined ? {} : { explanation: provenance.explanation }),
                    ...(provenance.purpose === undefined ? {} : { purpose: provenance.purpose })
                };
            });
        });
        this.#mutation = operation.then(() => undefined, () => undefined);
        return await operation;
    }

    async #initialize(): Promise<void> {
        this.#initializePromise ??= this.#load();
        await this.#initializePromise;
    }

    async #load(): Promise<void> {
        await this.#archive.initialize();
        let source: string;
        try {
            source = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if (isEnoent(error)) return;
            throw error;
        }
        const cutoff = this.#now() - this.#retentionMs;
        const records = parseRecords(source, { allowIncompleteTail: true })
            .filter((record) => Date.parse(record.recordedAt) >= cutoff);
        for (const record of records) {
            this.#hotRecords.set(provenanceKey(record.instance, record.callId), record);
        }
        const compacted = serializeRecords([...this.#hotRecords.values()]);
        if (compacted !== source) await writeFile(this.#filePath, compacted, { encoding: "utf8", mode: 0o600 });
        await this.#rotateIfNeeded();
    }

    async #pruneHotRetention(): Promise<void> {
        const cutoff = this.#now() - this.#retentionMs;
        let changed = false;
        for (const [key, record] of this.#hotRecords) {
            if (Date.parse(record.recordedAt) >= cutoff) continue;
            this.#hotRecords.delete(key);
            changed = true;
        }
        if (!changed) return;
        await writeFile(this.#filePath, serializeRecords([...this.#hotRecords.values()]), {
            encoding: "utf8",
            mode: 0o600
        });
    }

    async #rotateIfNeeded(): Promise<void> {
        let size: number;
        try {
            size = (await stat(this.#filePath)).size;
        } catch (error) {
            if (isEnoent(error)) return;
            throw error;
        }
        if (size <= this.#hotMaxBytes || this.#hotRecords.size === 0) return;
        const records = [...this.#hotRecords.values()];
        await this.#archive.append(records);
        await truncate(this.#filePath, 0);
        this.#hotRecords.clear();
    }
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
    return value;
}

function isEnoent(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
