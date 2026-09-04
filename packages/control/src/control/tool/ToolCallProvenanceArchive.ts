import { randomUUID } from "node:crypto";
import {
    mkdir,
    readFile,
    readdir,
    rename,
    stat,
    unlink,
    writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import type { McpToolProvenanceRecord } from "@portable-devshell/mcp";

export interface StoredToolCallProvenance extends McpToolProvenanceRecord {
    recordedAt: string;
    version: 1;
}

interface ArchiveEntry {
    bytes: number;
    keys: Set<string>;
    newestAtMs: number;
    oldestAtMs: number;
    path: string;
}

export class ToolCallProvenanceArchive {
    readonly #archiveDirectory: string;
    readonly #coldMaxBytes: number;
    readonly #index = new Map<string, string>();
    readonly #entries = new Map<string, ArchiveEntry>();
    readonly #retentionMs: number;
    readonly #now: () => number;

    constructor(options: {
        archiveDirectory: string;
        coldMaxBytes: number;
        now: () => number;
        retentionMs: number;
    }) {
        this.#archiveDirectory = options.archiveDirectory;
        this.#coldMaxBytes = options.coldMaxBytes;
        this.#now = options.now;
        this.#retentionMs = options.retentionMs;
    }

    async initialize(): Promise<void> {
        let names: string[];
        try {
            names = (await readdir(this.#archiveDirectory))
                .filter((name) => name.endsWith(".jsonl.zst"))
                .sort();
        } catch (error) {
            if (isEnoent(error)) return;
            throw error;
        }

        for (const name of names) {
            const path = join(this.#archiveDirectory, name);
            const original = await readArchive(path);
            const records = this.#retained(original);
            if (records.length === 0) {
                await unlink(path);
                continue;
            }
            if (records.length !== original.length) {
                await writeArchive(path, records);
            }
            await this.#indexArchive(path, records);
        }
        await this.#enforceBudget();
    }

    async append(records: readonly StoredToolCallProvenance[]): Promise<void> {
        if (records.length === 0) return;
        await mkdir(this.#archiveDirectory, { mode: 0o700, recursive: true });
        const stamp = String(this.#now()).padStart(13, "0");
        const path = join(this.#archiveDirectory, `${stamp}-${randomUUID()}.jsonl.zst`);
        await writeArchive(path, records);
        await this.#indexArchive(path, records);
        await this.#pruneRetention();
        await this.#enforceBudget();
    }

    async lookup(keys: readonly string[]): Promise<Map<string, StoredToolCallProvenance>> {
        await this.#pruneRetention();
        const cutoff = this.#now() - this.#retentionMs;
        const byArchive = new Map<string, Set<string>>();
        for (const key of keys) {
            const path = this.#index.get(key);
            if (path === undefined) continue;
            const wanted = byArchive.get(path) ?? new Set<string>();
            wanted.add(key);
            byArchive.set(path, wanted);
        }

        const found = new Map<string, StoredToolCallProvenance>();
        for (const [path, wanted] of byArchive) {
            for (const record of await readArchive(path)) {
                if (Date.parse(record.recordedAt) < cutoff) continue;
                const key = provenanceKey(record.instance, record.callId);
                if (wanted.has(key)) found.set(key, record);
            }
        }
        return found;
    }

    async #indexArchive(path: string, records: readonly StoredToolCallProvenance[]): Promise<void> {
        const keys = new Set<string>();
        let newestAtMs = 0;
        let oldestAtMs = Number.POSITIVE_INFINITY;
        for (const record of records) {
            const key = provenanceKey(record.instance, record.callId);
            keys.add(key);
            this.#index.set(key, path);
            const recordedAtMs = Date.parse(record.recordedAt);
            newestAtMs = Math.max(newestAtMs, recordedAtMs);
            oldestAtMs = Math.min(oldestAtMs, recordedAtMs);
        }
        const file = await stat(path);
        this.#entries.set(path, { bytes: file.size, keys, newestAtMs, oldestAtMs, path });
    }

    async #pruneRetention(): Promise<void> {
        const cutoff = this.#now() - this.#retentionMs;
        for (const entry of [...this.#entries.values()]) {
            if (entry.oldestAtMs >= cutoff) continue;
            const records = this.#retained(await readArchive(entry.path));
            if (records.length === 0) {
                await unlink(entry.path).catch((error) => {
                    if (!isEnoent(error)) throw error;
                });
                this.#entries.delete(entry.path);
                this.#dropIndex(entry);
                continue;
            }
            await writeArchive(entry.path, records);
            this.#dropIndex(entry);
            this.#entries.delete(entry.path);
            await this.#indexArchive(entry.path, records);
        }
    }

    async #enforceBudget(): Promise<void> {
        let bytes = [...this.#entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        if (bytes <= this.#coldMaxBytes) return;
        const oldest = [...this.#entries.values()].sort((a, b) =>
            a.newestAtMs - b.newestAtMs || a.path.localeCompare(b.path)
        );
        for (const entry of oldest) {
            if (bytes <= this.#coldMaxBytes) break;
            await unlink(entry.path).catch((error) => {
                if (!isEnoent(error)) throw error;
            });
            this.#entries.delete(entry.path);
            this.#dropIndex(entry);
            bytes -= entry.bytes;
        }
    }

    #dropIndex(entry: ArchiveEntry): void {
        for (const key of entry.keys) {
            if (this.#index.get(key) === entry.path) this.#index.delete(key);
        }
    }

    #retained(records: readonly StoredToolCallProvenance[]): StoredToolCallProvenance[] {
        const cutoff = this.#now() - this.#retentionMs;
        return records.filter((record) => Date.parse(record.recordedAt) >= cutoff);
    }
}

export function provenanceKey(instance: string, callId: string): string {
    return `${instance}\u0000${callId}`;
}

export function isStoredToolCallProvenance(value: unknown): value is StoredToolCallProvenance {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Partial<StoredToolCallProvenance>;
    return record.version === 1 &&
        typeof record.callId === "string" &&
        typeof record.instance === "string" &&
        typeof record.recordedAt === "string" &&
        Number.isFinite(Date.parse(record.recordedAt)) &&
        (record.purpose === undefined || typeof record.purpose === "string") &&
        (record.explanation === undefined || typeof record.explanation === "string");
}

async function readArchive(path: string): Promise<StoredToolCallProvenance[]> {
    const compressed = await readFile(path);
    const source = zstdDecompressSync(compressed).toString("utf8");
    return parseRecords(source);
}

async function writeArchive(
    path: string,
    records: readonly StoredToolCallProvenance[]
): Promise<void> {
    const source = serializeRecords(records);
    const compressed = zstdCompressSync(Buffer.from(source, "utf8"), {
        params: { [zlibConstants.ZSTD_c_compressionLevel]: 1 }
    });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, compressed, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
}

export function parseRecords(source: string): StoredToolCallProvenance[] {
    const records: StoredToolCallProvenance[] = [];
    for (const line of source.split("\n")) {
        if (line.length === 0) continue;
        const record = JSON.parse(line) as unknown;
        if (isStoredToolCallProvenance(record)) records.push(record);
    }
    return records;
}

export function serializeRecords(records: readonly StoredToolCallProvenance[]): string {
    return records.map((record) => JSON.stringify(record)).join("\n") + (records.length === 0 ? "" : "\n");
}

function isEnoent(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
