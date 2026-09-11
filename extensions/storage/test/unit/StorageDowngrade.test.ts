import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { executeStorageCommand } from "../../src/builtin/StorageCommand.ts";
import {
    downgradeAuditDatabase,
    downgradeConversationDatabase,
    inspectStorageDatabase,
} from "../../src/builtin/StorageDowngrade.ts";

function invocation(workingDirectory?: string, localOwner = true) {
    return {
        localOwner,
        requestId: "storage-test",
        signal: new AbortController().signal,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
    };
}

test("Audit downgrade v2 to v1 reconstructs compressed Logs without modifying the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-storage-audit-"));
    try {
        const source = join(root, "audit.sqlite3");
        const output = join(root, "audit-v1.sqlite3");
        createAuditV2(source);
        const sourceBefore = readFileSync(source);

        const result = downgradeAuditDatabase({ output, source, toVersion: 1 });

        assert.deepEqual(result, {
            fromVersion: 2,
            kind: "audit",
            output,
            records: 2,
            source,
            toVersion: 1,
        });
        assert.deepEqual(readFileSync(source), sourceBefore);
        const target = openDatabase(output, true);
        try {
            assert.equal(readUserVersion(target), 1);
            assert.deepEqual(
                (target.prepare("PRAGMA table_info(audit_records)").all() as Array<{ name: string }>).map((row) => row.name),
                ["id", "collection", "occurred_at_ms", "payload_bytes", "payload"],
            );
            const rows = target.prepare(
                "SELECT id, collection, payload_bytes AS payloadBytes, payload FROM audit_records ORDER BY id",
            ).all() as Array<{ collection: string; id: number; payload: string; payloadBytes: number }>;
            assert.equal(rows.length, 2);
            assert.deepEqual(JSON.parse(rows[0]!.payload), {
                at: "2026-09-11T00:00:00.000Z",
                callId: "call-log",
                message: "compressed log body ".repeat(200),
                seq: 1,
                stream: "stdout",
            });
            assert.equal(rows[0]!.payloadBytes, Buffer.byteLength(rows[0]!.payload, "utf8"));
            assert.deepEqual(JSON.parse(rows[1]!.payload), {
                callId: "call-tool",
                inputSummary: "{}",
                instance: "alpha",
                source: "mcp",
                startedAt: "2026-09-11T00:00:01.000Z",
                status: "completed",
                toolName: "file_read",
            });
        } finally {
            target.close();
        }
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Audit downgrade rejects unknown newer schemas and never creates an output", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-storage-future-"));
    try {
        const source = join(root, "audit.sqlite3");
        const output = join(root, "audit-v1.sqlite3");
        createFutureDatabase(source, 3);
        const sourceBefore = readFileSync(source);

        assert.throws(
            () => downgradeAuditDatabase({ output, source, toVersion: 1 }),
            /Upgrade portable-devshell and the Storage Extension/u,
        );
        assert.deepEqual(readFileSync(source), sourceBefore);
        assert.throws(() => readFileSync(output), /ENOENT/u);
        assert.throws(
            () => downgradeAuditDatabase({ output: source, source, toVersion: 1 }),
            /non-destructive/u,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Audit downgrade refuses to overwrite an existing output and preserves both files", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-storage-existing-output-"));
    try {
        const source = join(root, "audit.sqlite3");
        const output = join(root, "audit-v1.sqlite3");
        createAuditV2(source);
        writeFileSync(output, "preserve-target", { mode: 0o600 });
        const sourceBefore = readFileSync(source);
        const outputBefore = readFileSync(output);

        assert.throws(
            () => downgradeAuditDatabase({ output, source, toVersion: 1 }),
            /Refusing to overwrite existing downgrade output/u,
        );
        assert.deepEqual(readFileSync(source), sourceBefore);
        assert.deepEqual(readFileSync(output), outputBefore);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Conversation downgrade v1 exports legacy Context Comments and preserves Reports in the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-storage-conversation-"));
    try {
        const controlWorker = join(root, "alpha", "control-worker");
        await mkdir(controlWorker, { recursive: true });
        const source = join(controlWorker, "conversation.sqlite3");
        const output = join(root, "context-messages.json");
        createConversationV1(source);
        const sourceBefore = readFileSync(source);

        const result = downgradeConversationDatabase({ output, source, toVersion: 0 });

        assert.deepEqual(result, {
            comments: 1,
            fromVersion: 1,
            instance: "alpha",
            kind: "conversation",
            output,
            reports: 1,
            source,
            toVersion: 0,
        });
        assert.deepEqual(readFileSync(source), sourceBefore);
        assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
            messages: [{
                callId: "call-comment",
                createdAt: "2026-09-11T00:00:00.000Z",
                ctxId: "ctx-alpha",
                deliveredAt: "2026-09-11T00:00:01.000Z",
                id: "message-1",
                instance: "alpha",
                status: "delivered",
                text: "legacy comment",
            }],
            version: 1,
        });
        assert.deepEqual(inspectStorageDatabase(source), {
            filePath: source,
            kind: "conversation",
            schemaVersion: 1,
        });
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Storage native command requires local owner and explicit non-destructive downgrade arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "devshell-storage-command-"));
    try {
        const source = join(root, "audit.sqlite3");
        createAuditV2(source);
        await assert.rejects(executeStorageCommand(["inspect", source], invocation(undefined, false)), /local owner/u);
        const result = await executeStorageCommand(["inspect", "audit.sqlite3"], invocation(root));
        assert.equal(result.kind, "json");
        assert.deepEqual(result.value, {
            filePath: source,
            kind: "audit",
            schemaVersion: 2,
        });
        await assert.rejects(
            executeStorageCommand(["downgrade", "audit", source, "--to", "1"], invocation(root)),
            /requires --output/u,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

function createAuditV2(filePath: string): void {
    const database = openDatabase(filePath);
    try {
        database.exec(`
            CREATE TABLE audit_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL,
                payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
                payload TEXT NOT NULL,
                body BLOB,
                body_codec TEXT
            ) STRICT;
            PRAGMA user_version = 2;
        `);
        const logMetadata = JSON.stringify({
            at: "2026-09-11T00:00:00.000Z",
            callId: "call-log",
            seq: 1,
            stream: "stdout",
        });
        const logBody = Buffer.from("compressed log body ".repeat(200), "utf8");
        database.prepare(
            "INSERT INTO audit_records(id, collection, occurred_at_ms, payload_bytes, payload, body, body_codec) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(1, "logs", 1, Buffer.byteLength(logMetadata) + logBody.byteLength, logMetadata, zstdCompressSync(logBody), "zstd");
        const tool = JSON.stringify({
            callId: "call-tool",
            inputSummary: "{}",
            instance: "alpha",
            source: "mcp",
            startedAt: "2026-09-11T00:00:01.000Z",
            status: "completed",
            toolName: "file_read",
        });
        database.prepare(
            "INSERT INTO audit_records(id, collection, occurred_at_ms, payload_bytes, payload) VALUES (?, ?, ?, ?, ?)",
        ).run(2, "toolCalls", 2, Buffer.byteLength(tool), tool);
    } finally {
        database.close();
    }
}

function createConversationV1(filePath: string): void {
    const database = openDatabase(filePath);
    try {
        database.exec(`
            CREATE TABLE conversation_entries (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK(kind IN ('comment', 'report')),
                id TEXT NOT NULL,
                ctx_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                text TEXT NOT NULL,
                status TEXT CHECK(status IS NULL OR status IN ('pending', 'sent', 'delivered', 'failed')),
                call_id TEXT,
                delivered_at TEXT,
                failed_at TEXT,
                error TEXT,
                UNIQUE(kind, id)
            ) STRICT;
            PRAGMA user_version = 1;
        `);
        database.prepare(`
            INSERT INTO conversation_entries(kind, id, ctx_id, created_at, text, status, call_id, delivered_at)
            VALUES ('comment', ?, ?, ?, ?, 'delivered', ?, ?)
        `).run(
            "message-1",
            "ctx-alpha",
            "2026-09-11T00:00:00.000Z",
            "legacy comment",
            "call-comment",
            "2026-09-11T00:00:01.000Z",
        );
        database.prepare(`
            INSERT INTO conversation_entries(kind, id, ctx_id, created_at, text, call_id)
            VALUES ('report', ?, ?, ?, ?, ?)
        `).run("report-call", "ctx-alpha", "2026-09-11T00:00:02.000Z", "report body", "report-call");
    } finally {
        database.close();
    }
}

function createFutureDatabase(filePath: string, version: number): void {
    const database = openDatabase(filePath);
    try {
        database.exec(`
            CREATE TABLE future_sentinel (value TEXT NOT NULL) STRICT;
            INSERT INTO future_sentinel(value) VALUES ('preserve-me');
            PRAGMA user_version = ${version};
        `);
    } finally {
        database.close();
    }
}

function openDatabase(filePath: string, readOnly = false) {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    return new DatabaseSync(filePath, { readOnly, timeout: 5_000 });
}

function readUserVersion(database: import("node:sqlite").DatabaseSync): number {
    return Number(Object.values(database.prepare("PRAGMA user_version").get() as Record<string, number>)[0] ?? 0);
}
