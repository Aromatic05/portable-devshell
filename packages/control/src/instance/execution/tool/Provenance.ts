import { appendFile, mkdir, open, readFile, readdir, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpToolProvenanceRecord, McpToolProvenanceRecorder } from "@portable-devshell/mcp";
import type { ToolCallRecord } from "@portable-devshell/shared";
import { randomUUID } from "node:crypto";
import { constants as zlibConstants, zstdCompress, zstdDecompress } from "node:zlib";

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
    #archiveInitializePromise?: Promise<void>;
    #initialized = false;
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
        const operation = this.#mutation.then(async () => {
            if (this.#initializePromise !== undefined) await this.#initialize();
            if (this.#initialized) await this.#pruneHotRetention();
            else await this.#repairIncompleteHotTail();
            const stored: StoredToolCallProvenance = {
                ...record,
                recordedAt: new Date(this.#now()).toISOString(),
                version: RECORD_VERSION
            };
            await mkdir(dirname(this.#filePath), { mode: 0o700, recursive: true });
            await appendFile(this.#filePath, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
            if (this.#initialized) this.#hotRecords.set(provenanceKey(record.instance, record.callId), stored);
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
            if (missing.length > 0) await this.#initializeArchive();
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
        let source: string;
        try {
            source = await readFile(this.#filePath, "utf8");
        } catch (error) {
            if (isEnoent(error)) {
                this.#initialized = true;
                return;
            }
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
        this.#initialized = true;
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
        if (size <= this.#hotMaxBytes) return;
        if (!this.#initialized) {
            await this.#initialize();
            size = (await stat(this.#filePath)).size;
            if (size <= this.#hotMaxBytes) return;
        }
        if (this.#hotRecords.size === 0) return;
        const records = [...this.#hotRecords.values()];
        await this.#initializeArchive();
        await this.#archive.append(records);
        await truncate(this.#filePath, 0);
        this.#hotRecords.clear();
    }

    async #initializeArchive(): Promise<void> {
        this.#archiveInitializePromise ??= this.#archive.initialize();
        await this.#archiveInitializePromise;
    }

    async #repairIncompleteHotTail(): Promise<void> {
        let fileSize: number;
        try {
            fileSize = (await stat(this.#filePath)).size;
        } catch (error) {
            if (isEnoent(error)) return;
            throw error;
        }
        if (fileSize === 0) return;
        const handle = await open(this.#filePath, "r");
        try {
            let end = fileSize;
            const buffer = Buffer.alloc(Math.min(64 * 1024, fileSize));
            while (end > 0) {
                const start = Math.max(0, end - buffer.length);
                const length = end - start;
                await handle.read(buffer, 0, length, start);
                if (buffer[length - 1] === 0x0a) return;
                const newline = buffer.subarray(0, length).lastIndexOf(0x0a);
                if (newline >= 0) {
                    await truncate(this.#filePath, start + newline + 1);
                    return;
                }
                end = start;
            }
            await truncate(this.#filePath, 0);
        } finally {
            await handle.close();
        }
    }
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
    return value;
}

function isEnoent(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

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
    const source = (await decompress(compressed)).toString("utf8");
    return parseRecords(source);
}

async function writeArchive(
    path: string,
    records: readonly StoredToolCallProvenance[]
): Promise<void> {
    const source = serializeRecords(records);
    const compressed = await compress(Buffer.from(source, "utf8"), {
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

function decompress(source: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        zstdDecompress(source, (error, result) => error === null ? resolve(result) : reject(error));
    });
}

function compress(source: Buffer, options: Parameters<typeof zstdCompress>[1]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        zstdCompress(source, options, (error, result) => error === null ? resolve(result) : reject(error));
    });
}

export function parseRecords(
    source: string,
    options: { allowIncompleteTail?: boolean } = {}
): StoredToolCallProvenance[] {
    const records: StoredToolCallProvenance[] = [];
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.length === 0) continue;
        let record: unknown;
        try {
            record = JSON.parse(line) as unknown;
        } catch (error) {
            const incompleteTail = options.allowIncompleteTail === true &&
                index === lines.length - 1 && !source.endsWith("\n");
            if (incompleteTail) break;
            throw error;
        }
        if (isStoredToolCallProvenance(record)) records.push(record);
    }
    return records;
}

export function serializeRecords(records: readonly StoredToolCallProvenance[]): string {
    return records.map((record) => JSON.stringify(record)).join("\n") + (records.length === 0 ? "" : "\n");
}
