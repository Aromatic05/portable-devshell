import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { migrateMessageDatabase } from "../../src/message/store/MessageStorage.ts";

const entries = `
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
`;

function database(file: string, version: 1 | 2, rows: Array<[string, string]>): void {
    mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
        const table = version === 1 ? "conversation_entries" : "message_entries";
        const metadata = version === 1 ? "conversation_metadata" : "message_metadata";
        db.exec(`
            CREATE TABLE ${table} (${entries}) STRICT;
            CREATE TABLE ${metadata} (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
            PRAGMA user_version = ${version};
        `);
        const insert = db.prepare(
            `INSERT INTO ${table}(kind,id,ctx_id,created_at,text,status) VALUES('comment',?, 'ctx-test', '2026-09-25T09:00:00.000Z',?, 'delivered')`,
        );
        for (const [id, text] of rows) insert.run(id, text);
        db.prepare(`INSERT INTO ${metadata}(key,value) VALUES('retention','90')`).run();
    } finally {
        db.close();
    }
}

function snapshot(file: string, version: 1 | 2) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const table = version === 1 ? "conversation_entries" : "message_entries";
        const metadata = version === 1 ? "conversation_metadata" : "message_metadata";
        return {
            rows: db.prepare(`SELECT id, text FROM ${table} ORDER BY id`).all()
                .map((row) => ({ id: row.id, text: row.text })),
            metadata: db.prepare(`SELECT key,value FROM ${metadata} ORDER BY key`).all()
                .map((row) => ({ key: row.key, value: row.value })),
            schema: db.prepare("PRAGMA user_version").get()?.user_version,
        };
    } finally {
        db.close();
    }
}

test("Comment migrates the actual 0.7.7 conversation.sqlite3 default filename", async () => {
    const root = mkdtempSync(join(tmpdir(), "pds-legacy-comment-"));
    const previous = process.env.PORTABLE_DEVSHELL_HOME;
    process.env.PORTABLE_DEVSHELL_HOME = join(root, "legacy-home");
    try {
        const source = join(process.env.PORTABLE_DEVSHELL_HOME, "legacy", "control-worker", "conversation.sqlite3");
        const target = join(root, "extension-data", "instances", "legacy", "message.sqlite3");
        database(source, 1, [["legacy-comment", "historical-data"]]);
        await migrateMessageDatabase({ instance: "legacy", targetFile: target });
        assert.deepEqual(snapshot(target, 1), snapshot(source, 1));
    } finally {
        if (previous === undefined) delete process.env.PORTABLE_DEVSHELL_HOME;
        else process.env.PORTABLE_DEVSHELL_HOME = previous;
        rmSync(root, { recursive: true, force: true });
    }
});

test("Comment reconciles an existing empty Host DB without dropping historical comments", async () => {
    const root = mkdtempSync(join(tmpdir(), "pds-legacy-comment-"));
    try {
        const source = join(root, "conversation.sqlite3");
        const target = join(root, "message.sqlite3");
        database(source, 1, [["legacy-comment", "never-drop"]]);
        database(target, 2, []);
        await migrateMessageDatabase({ instance: "legacy", sourceFile: source, targetFile: target });
        assert.deepEqual(snapshot(target, 2).rows, [{ id: "legacy-comment", text: "never-drop" }]);
        assert.equal(snapshot(target, 2).metadata.some(({ key }) => key === "migration.legacy-conversation-imported"), true);
        assert.deepEqual(snapshot(source, 1).rows, [{ id: "legacy-comment", text: "never-drop" }]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Comment merges historical and newer data without overwriting newer edits or reimporting compacted entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "pds-legacy-comment-"));
    try {
        const source = join(root, "conversation.sqlite3");
        const target = join(root, "message.sqlite3");
        database(source, 1, [["same-id", "old-content"], ["legacy-only", "historical"]]);
        database(target, 2, [["same-id", "current-content"], ["new-only", "modern"]]);
        await migrateMessageDatabase({ instance: "legacy", sourceFile: source, targetFile: target });
        assert.deepEqual(snapshot(target, 2).rows, [
            { id: "legacy-only", text: "historical" },
            { id: "new-only", text: "modern" },
            { id: "same-id", text: "current-content" },
        ]);
        const db = new DatabaseSync(target);
        db.prepare("DELETE FROM message_entries WHERE id = ?").run("legacy-only");
        db.close();
        await migrateMessageDatabase({ instance: "legacy", sourceFile: source, targetFile: target });
        assert.equal(snapshot(target, 2).rows.some(({ id }) => id === "legacy-only"), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Comment refuses multiple differently named legacy stores instead of silently choosing one", async () => {
    const root = mkdtempSync(join(tmpdir(), "pds-legacy-comment-"));
    const previous = process.env.PORTABLE_DEVSHELL_HOME;
    process.env.PORTABLE_DEVSHELL_HOME = join(root, "legacy-home");
    try {
        const old = join(process.env.PORTABLE_DEVSHELL_HOME, "legacy", "control-worker");
        database(join(old, "conversation.sqlite3"), 1, [["old", "a"]]);
        database(join(old, "message.sqlite3"), 1, [["middle", "b"]]);
        const target = join(root, "extension-data", "message.sqlite3");
        await assert.rejects(
            migrateMessageDatabase({ instance: "legacy", targetFile: target }),
            /Multiple legacy message databases/,
        );
        assert.equal(snapshot(join(old, "conversation.sqlite3"), 1).rows.length, 1);
        assert.equal(snapshot(join(old, "message.sqlite3"), 1).rows.length, 1);
    } finally {
        if (previous === undefined) delete process.env.PORTABLE_DEVSHELL_HOME;
        else process.env.PORTABLE_DEVSHELL_HOME = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
