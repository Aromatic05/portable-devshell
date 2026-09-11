import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";

const SUPPORTED_AUDIT_SOURCE_VERSION = 2;
const SUPPORTED_CONVERSATION_SOURCE_VERSION = 1;

export interface StorageDatabaseInspection {
    filePath: string;
    kind: "audit" | "conversation" | "unknown";
    schemaVersion: number;
}

export interface AuditDowngradeResult {
    fromVersion: number;
    kind: "audit";
    output: string;
    records: number;
    source: string;
    toVersion: 1;
}

export interface ConversationDowngradeResult {
    comments: number;
    fromVersion: 1;
    instance: string;
    kind: "conversation";
    output: string;
    reports: number;
    source: string;
    toVersion: 0;
}

export function inspectStorageDatabase(filePath: string): StorageDatabaseInspection {
    const source = resolve(filePath);
    requireSourceFile(source);
    const database = openReadOnlyDatabase(source);
    try {
        const tables = new Set(
            (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
                .map((row) => row.name),
        );
        return {
            filePath: source,
            kind: tables.has("audit_records")
                ? "audit"
                : tables.has("conversation_entries")
                  ? "conversation"
                  : "unknown",
            schemaVersion: readUserVersion(database),
        };
    } finally {
        database.close();
    }
}

export function downgradeAuditDatabase(options: {
    output: string;
    source: string;
    signal?: AbortSignal;
    toVersion: number;
}): AuditDowngradeResult {
    options.signal?.throwIfAborted();
    if (options.toVersion !== 1) throw new TypeError("Audit downgrade currently supports only --to 1.");
    const source = resolve(options.source);
    const output = resolve(options.output);
    requireSeparateOutput(source, output);
    requireSourceFile(source);
    requireOutputAbsent(output);

    const input = openReadOnlyDatabase(source);
    let recordCount = 0;
    let fromVersion = 0;
    try {
        fromVersion = readUserVersion(input);
        if (fromVersion < 1 || fromVersion > SUPPORTED_AUDIT_SOURCE_VERSION) {
            throw unsupportedSourceVersion("Audit", fromVersion, SUPPORTED_AUDIT_SOURCE_VERSION);
        }
        const temp = temporaryOutputPath(output);
        mkdirSync(dirname(output), { recursive: true });
        try {
            const target = openWritableDatabase(temp);
            try {
                target.exec(`
                    CREATE TABLE audit_records (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        collection TEXT NOT NULL,
                        occurred_at_ms INTEGER NOT NULL,
                        payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
                        payload TEXT NOT NULL
                    ) STRICT;
                    PRAGMA user_version = 1;
                `);
                const insert = target.prepare(
                    "INSERT INTO audit_records(id, collection, occurred_at_ms, payload_bytes, payload) VALUES (?, ?, ?, ?, ?)",
                );
                target.exec("BEGIN IMMEDIATE");
                try {
                    for (const row of readAuditRows(input, fromVersion)) {
                        options.signal?.throwIfAborted();
                        const payload = decodeAuditPayload(row);
                        insert.run(
                            row.id,
                            row.collection,
                            row.occurredAtMs,
                            Buffer.byteLength(payload, "utf8"),
                            payload,
                        );
                        recordCount += 1;
                    }
                    target.exec("COMMIT");
                } catch (error) {
                    target.exec("ROLLBACK");
                    throw error;
                }
                assertQuickCheck(target, "downgraded Audit database");
            } finally {
                target.close();
            }
            finalizeAtomicOutput(temp, output);
        } catch (error) {
            rmSync(temp, { force: true });
            throw error;
        }
    } finally {
        input.close();
    }
    return { fromVersion, kind: "audit", output, records: recordCount, source, toVersion: 1 };
}

export function downgradeConversationDatabase(options: {
    instance?: string;
    output: string;
    source: string;
    signal?: AbortSignal;
    toVersion: number;
}): ConversationDowngradeResult {
    options.signal?.throwIfAborted();
    if (options.toVersion !== 0) throw new TypeError("Conversation downgrade currently supports only --to 0 (legacy JSON).");
    const source = resolve(options.source);
    const output = resolve(options.output);
    requireSeparateOutput(source, output);
    requireSourceFile(source);
    requireOutputAbsent(output);

    const input = openReadOnlyDatabase(source);
    try {
        const fromVersion = readUserVersion(input);
        if (fromVersion !== SUPPORTED_CONVERSATION_SOURCE_VERSION) {
            throw unsupportedSourceVersion("Conversation", fromVersion, SUPPORTED_CONVERSATION_SOURCE_VERSION);
        }
        const instance = options.instance ?? inferInstanceName(source);
        const comments = (input.prepare(`
            SELECT
                call_id AS callId,
                created_at AS createdAt,
                ctx_id AS ctxId,
                delivered_at AS deliveredAt,
                error,
                failed_at AS failedAt,
                id,
                status,
                text
            FROM conversation_entries
            WHERE kind = 'comment'
            ORDER BY created_at ASC, seq ASC
        `).all() as Array<{
            callId: string | null;
            createdAt: string;
            ctxId: string;
            deliveredAt: string | null;
            error: string | null;
            failedAt: string | null;
            id: string;
            status: string | null;
            text: string;
        }>).map((row) => {
            if (row.status === null) throw new Error(`Conversation Comment ${row.id} has no status.`);
            return {
                ...(row.callId === null ? {} : { callId: row.callId }),
                createdAt: row.createdAt,
                ctxId: row.ctxId,
                ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
                ...(row.error === null ? {} : { error: row.error }),
                ...(row.failedAt === null ? {} : { failedAt: row.failedAt }),
                id: row.id,
                instance,
                status: row.status,
                text: row.text,
            };
        });
        const reports = Number((input.prepare(
            "SELECT COUNT(*) AS count FROM conversation_entries WHERE kind = 'report'",
        ).get() as { count: number }).count);
        const temp = temporaryOutputPath(output);
        mkdirSync(dirname(output), { recursive: true });
        try {
            writeFileSync(temp, `${JSON.stringify({ messages: comments, version: 1 })}\n`, { flag: "wx", mode: 0o600 });
            finalizeAtomicOutput(temp, output);
        } catch (error) {
            rmSync(temp, { force: true });
            throw error;
        }
        return {
            comments: comments.length,
            fromVersion: 1,
            instance,
            kind: "conversation",
            output,
            reports,
            source,
            toVersion: 0,
        };
    } finally {
        input.close();
    }
}

interface AuditRow {
    body: Uint8Array | null;
    bodyCodec: string | null;
    collection: string;
    id: number;
    occurredAtMs: number;
    payload: string;
}

function readAuditRows(database: DatabaseSync, version: number): Iterable<AuditRow> {
    if (version === 1) {
        return database.prepare(`
            SELECT id, collection, occurred_at_ms AS occurredAtMs, payload,
                   NULL AS body, NULL AS bodyCodec
            FROM audit_records
            ORDER BY id ASC
        `).iterate() as Iterable<AuditRow>;
    }
    return database.prepare(`
        SELECT id, collection, occurred_at_ms AS occurredAtMs, payload,
               body, body_codec AS bodyCodec
        FROM audit_records
        ORDER BY id ASC
    `).iterate() as Iterable<AuditRow>;
}

function decodeAuditPayload(row: AuditRow): string {
    if (row.body === null) return row.payload;
    if (row.collection !== "logs") {
        throw new Error(`Audit row ${row.id} has a body outside the logs collection.`);
    }
    let message: Buffer;
    if (row.bodyCodec === "identity") message = Buffer.from(row.body);
    else if (row.bodyCodec === "zstd") message = zstdDecompressSync(row.body);
    else throw new Error(`Audit row ${row.id} uses unsupported body codec ${String(row.bodyCodec)}.`);
    const metadata = JSON.parse(row.payload) as unknown;
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
        throw new Error(`Audit row ${row.id} log metadata must be an object.`);
    }
    return JSON.stringify({ ...(metadata as Record<string, unknown>), message: message.toString("utf8") });
}

function inferInstanceName(source: string): string {
    if (basename(dirname(source)) !== "control-worker") {
        throw new TypeError("Conversation downgrade requires --instance when the database is not inside <instance>/control-worker/.");
    }
    const instance = basename(dirname(dirname(source)));
    if (instance.length === 0) throw new TypeError("Unable to infer the instance name; pass --instance explicitly.");
    return instance;
}

function openReadOnlyDatabase(filePath: string): DatabaseSync {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    return new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
}

function openWritableDatabase(filePath: string): DatabaseSync {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    return new DatabaseSync(filePath, { timeout: 5_000 });
}

function readUserVersion(database: DatabaseSync): number {
    return Number(Object.values(database.prepare("PRAGMA user_version").get() as Record<string, number>)[0] ?? 0);
}

function assertQuickCheck(database: DatabaseSync, label: string): void {
    const row = database.prepare("PRAGMA quick_check").get() as Record<string, string>;
    if (String(Object.values(row)[0] ?? "") !== "ok") throw new Error(`${label} failed PRAGMA quick_check.`);
}

function requireSourceFile(filePath: string): void {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        throw new TypeError(`Storage source is not a file: ${filePath}`);
    }
}

function requireOutputAbsent(filePath: string): void {
    if (existsSync(filePath)) throw new TypeError(`Refusing to overwrite existing downgrade output: ${filePath}`);
}

function requireSeparateOutput(source: string, output: string): void {
    if (source === output) throw new TypeError("Downgrade is non-destructive and requires an output path different from the source.");
}

function unsupportedSourceVersion(label: string, actual: number, supported: number): Error {
    return new Error(
        `${label} database schema version ${actual} is not supported by this Storage Extension (maximum ${supported}). ` +
        "Upgrade portable-devshell and the Storage Extension before converting this database. The source was not modified.",
    );
}

function temporaryOutputPath(output: string): string {
    return `${output}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
}

function finalizeAtomicOutput(temp: string, output: string): void {
    chmodSync(temp, 0o600);
    const file = openSync(temp, "r");
    try {
        fsyncSync(file);
    } finally {
        closeSync(file);
    }
    requireOutputAbsent(output);
    renameSync(temp, output);
    const directory = openSync(dirname(output), "r");
    try {
        fsyncSync(directory);
    } finally {
        closeSync(directory);
    }
}
