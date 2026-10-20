import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { CommentService } from "../../src/comment/CommentService.ts";
import { migrateMessageDatabase } from "../../src/message/migration/index.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { databaseConnection } from "../helpers/Database.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const importMarker = "migration.legacy-conversation-imported";
const receiptMarker = "migration.legacy-mailing-notifications-imported";
const identity = { instance: "alpha", workspace: "/workspace", ctxId: "owner", mailId: "sender#1", kind: "inbox:receiver" };
const notice = { ctxId: "owner", text: "New Mail\nFrom: sender\nSubject: First copy" };

async function firstCopyFixture(t: TestContext) {
    const root = await createTestTempDirectory("mailing-first-copy");
    const sourceFile = join(root, "source.sqlite3");
    const targetFile = join(root, "target.sqlite3");
    const source = new MessageStore({ filePath: sourceFile, instanceName: "alpha", openDatabase: () => databaseConnection(sourceFile) });
    const previous = new CommentService({ instanceName: "alpha", store: source, appendEvent: async () => {} });
    await source.list();
    await source.close();
    let now = 0;
    const target = new MessageStore({ filePath: targetFile, instanceName: "alpha", openDatabase: () => databaseConnection(targetFile),
        retentionDays: 1, now: () => now });
    const events: unknown[] = [];
    const current = new CommentService({ instanceName: "alpha", store: target, appendEvent: async (_type, data) => { events.push(data); } });
    t.after(async () => { await source.close(); await target.close(); });
    const migrate = () => migrateMessageDatabase({ instance: "alpha", sourceFile, targetFile });
    return { root, sourceFile, targetFile, source, previous, target, current, events, migrate, setNow: (value: number) => { now = value; } };
}

function execute(file: string, sql: string): void {
    const database = new DatabaseSync(file);
    try { database.exec(sql); } finally { database.close(); }
}

function rows(file: string, sql: string) {
    const database = new DatabaseSync(file, { readOnly: true });
    try { return database.prepare(sql).all().map((row) => ({ ...row })); } finally { database.close(); }
}

for (const legacy of [
    { name: "v1 without metadata", sql: "DROP TABLE mailing_notifications; ALTER TABLE message_entries RENAME TO conversation_entries; DROP TABLE message_metadata; PRAGMA user_version = 1;", version: 1 },
    { name: "v1 with metadata", sql: "DROP TABLE mailing_notifications; ALTER TABLE message_entries RENAME TO conversation_entries; ALTER TABLE message_metadata RENAME TO conversation_metadata; PRAGMA user_version = 1;", version: 1 },
    { name: "v2", sql: "DROP TABLE mailing_notifications; PRAGMA user_version = 2;", version: 2 },
    { name: "v3", sql: "", version: 3 },
]) {
    test(`Mailing first copy of ${legacy.name} records completion before publication and never resurrects retained history`, async (t) => {
        const { sourceFile, targetFile, source, previous, target, current, migrate, setNow } = await firstCopyFixture(t);
        const original = await previous.queue(notice);
        await source.close();
        execute(sourceFile, legacy.sql);
        const sourceBytes = readFileSync(sourceFile);
        await migrate();
        assert.deepEqual(rows(targetFile, "PRAGMA user_version"), [{ user_version: legacy.version }]);
        setNow(Date.parse(original.createdAt));
        assert.deepEqual((await current.consumePending("owner", "first-delivery")).messages.map(({ id }) => id), [original.id]);
        await target.appendReport({ ctxId: "owner", callId: "reply", createdAt: original.createdAt, text: "Handled", replyCommentId: original.id });
        const markers = rows(targetFile, `SELECT key, value FROM message_metadata WHERE key IN ('${importMarker}', '${receiptMarker}') ORDER BY key`);
        setNow(Date.parse(original.createdAt) + 2 * 24 * 60 * 60 * 1000);
        assert.deepEqual(await current.list(), []);
        await target.close();
        await migrate();
        assert.deepEqual(rows(targetFile, "SELECT * FROM message_entries"), []);
        assert.deepEqual((await current.consumePending("owner", "after-retention")).messages, []);
        assert.deepEqual(markers, [{ key: importMarker, value: "source.sqlite3" }, { key: receiptMarker, value: "source.sqlite3" }]);
        assert.deepEqual(readFileSync(sourceFile), sourceBytes);
    });
}

for (const acknowledged of [0, 1]) {
    test(`Mailing first copy preserves v3 receipts and acknowledgement ${acknowledged} after delivery and retention`, async (t) => {
        const { sourceFile, targetFile, source, previous, target, current, events, migrate, setNow } = await firstCopyFixture(t);
        const original = await previous.queue(notice, identity);
        await source.close();
        execute(sourceFile, `UPDATE mailing_notifications SET queued_event_recorded = ${acknowledged};
            INSERT INTO message_metadata VALUES ('${importMarker}', 'earlier.sqlite3'), ('${receiptMarker}', 'earlier.sqlite3');`);
        const sourceBytes = readFileSync(sourceFile);
        await migrate();
        assert.deepEqual(rows(targetFile, "SELECT * FROM mailing_notifications"), rows(sourceFile, "SELECT * FROM mailing_notifications"));
        assert.deepEqual(rows(targetFile, `SELECT key, value FROM message_metadata WHERE key IN ('${importMarker}', '${receiptMarker}') ORDER BY key`),
            [{ key: importMarker, value: "source.sqlite3" }, { key: receiptMarker, value: "source.sqlite3" }]);
        setNow(Date.parse(original.createdAt));
        assert.equal((await current.queue(notice, identity)).id, original.id);
        assert.equal(events.length, 1 - acknowledged);
        assert.deepEqual((await current.consumePending("owner", "first-delivery")).messages.map(({ id }) => id), [original.id]);
        await target.appendReport({ ctxId: "owner", callId: "reply", createdAt: original.createdAt, text: "Handled", replyCommentId: original.id });
        setNow(Date.parse(original.createdAt) + 2 * 24 * 60 * 60 * 1000);
        assert.deepEqual(await current.list(), []);
        await target.close();
        await migrate();
        events.length = 0;
        assert.equal((await current.queue(notice, identity)).id, original.id);
        assert.equal(events.length, 0);
        assert.deepEqual(await current.list(), []);
        assert.deepEqual((await current.consumePending("owner", "after-retention")).messages, []);
        assert.deepEqual(rows(targetFile, "SELECT comment_id, queued_event_recorded FROM mailing_notifications"),
            [{ comment_id: original.id, queued_event_recorded: 1 }]);
        assert.deepEqual(readFileSync(sourceFile), sourceBytes);
    });
}

test("Mailing first copy rejects missing v3 receipts before publication and retries a repaired source", async (t) => {
    const { root, sourceFile, targetFile, source, previous, current, migrate } = await firstCopyFixture(t);
    const original = await previous.queue(notice);
    await source.close();
    const definition = rows(sourceFile, "SELECT sql FROM sqlite_master WHERE name = 'mailing_notifications'")[0]!.sql as string;
    execute(sourceFile, "DROP TABLE mailing_notifications");
    const invalidBytes = readFileSync(sourceFile);
    await assert.rejects(migrate(), /missing mailing_notifications/u);
    assert.equal(existsSync(targetFile), false);
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".migrating")), []);
    assert.deepEqual(readFileSync(sourceFile), invalidBytes);
    execute(sourceFile, definition);
    const repairedBytes = readFileSync(sourceFile);
    await migrate();
    assert.deepEqual((await current.list()).map(({ id }) => id), [original.id]);
    await migrate();
    assert.deepEqual(readFileSync(sourceFile), repairedBytes);
});

test("Mailing first copy ignores disposable cleanup EIO after unlink takes effect", async (t) => {
    const { root, sourceFile, targetFile, source, previous, target, current, migrate } = await firstCopyFixture(t);
    const original = await previous.queue(notice, identity);
    await source.close();
    const sourceBytes = readFileSync(sourceFile);
    const unlink = fs.unlink;
    const cleanups: Array<{ file: string; published: boolean }> = [];
    const cleanup = t.mock.method(fs, "unlink", async (file: Parameters<typeof unlink>[0]) => {
        cleanups.push({ file: String(file), published: existsSync(targetFile) });
        await unlink(file);
        throw Object.assign(new Error("injected post-unlink EIO"), { code: "EIO" });
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await migrate();
    assert.equal(cleanup.mock.callCount(), 1);
    assert.equal(cleanups[0]!.file.startsWith(`${targetFile}.`), true);
    assert.equal(cleanups[0]!.file.endsWith(".migrating"), true);
    assert.equal(cleanups[0]!.published, true);
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".migrating")), []);
    assert.equal((await current.queue(notice, identity)).id, original.id);
    assert.deepEqual((await current.consumePending("owner", "after-cleanup-error")).messages.map(({ id }) => id), [original.id]);
    await target.close();
    await migrate();
    assert.deepEqual((await current.consumePending("owner", "retry")).messages, []);
    assert.deepEqual(readFileSync(sourceFile), sourceBytes);
});

test("Mailing first copy never publishes a backup whose completion markers cannot commit", async (t) => {
    const { root, sourceFile, targetFile, source, previous, current, migrate } = await firstCopyFixture(t);
    const original = await previous.queue(notice, identity);
    await source.close();
    execute(sourceFile, `CREATE TRIGGER interrupt_marker BEFORE INSERT ON message_metadata
        WHEN NEW.key = '${receiptMarker}' BEGIN SELECT RAISE(ABORT, 'Injected copy marker failure'); END;`);
    const sourceBytes = readFileSync(sourceFile);
    await assert.rejects(migrate(), /Injected copy marker failure/u);
    assert.equal(existsSync(targetFile), false);
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".migrating")), []);
    assert.deepEqual(readFileSync(sourceFile), sourceBytes);
    execute(sourceFile, "DROP TRIGGER interrupt_marker");
    const repairedBytes = readFileSync(sourceFile);
    await migrate();
    assert.equal((await current.queue(notice, identity)).id, original.id);
    assert.deepEqual(readFileSync(sourceFile), repairedBytes);
});

test("Mailing first-copy publication race rolls back conflicting target data and retries after repair", async (t) => {
    const { root, sourceFile, targetFile, source, previous, target, current, migrate } = await firstCopyFixture(t);
    await previous.queue({ ...notice, text: "Earlier source entry must roll back" });
    const original = await previous.queue(notice, identity);
    await source.close();
    const sourceBytes = readFileSync(sourceFile);
    const link = fs.link;
    let before: ReturnType<typeof snapshot> | undefined;
    const publication = t.mock.method(fs, "link", async (...args: Parameters<typeof link>) => {
        await target.insertComment({ ...original, text: "Conflicting concurrent admission" });
        await target.close();
        before = snapshot(targetFile);
        return await link(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(migrate(), /Legacy Mailing migration conflict.*rolled back/u);
    assert.equal(publication.mock.callCount(), 1);
    assert.deepEqual(snapshot(targetFile), before);
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".migrating")), []);
    assert.deepEqual(readFileSync(sourceFile), sourceBytes);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    execute(targetFile, "DELETE FROM message_entries");
    await migrate();
    assert.equal((await current.queue(notice, identity)).id, original.id);
    assert.equal((await current.list()).length, 2);
    assert.deepEqual(readFileSync(sourceFile), sourceBytes);
});

function snapshot(file: string) {
    return {
        schema: rows(file, "SELECT * FROM sqlite_master ORDER BY name"),
        entries: rows(file, "SELECT * FROM message_entries ORDER BY seq"),
        receipts: rows(file, "SELECT * FROM mailing_notifications ORDER BY comment_id"),
        metadata: rows(file, "SELECT * FROM message_metadata ORDER BY key"),
        sequence: rows(file, "SELECT * FROM sqlite_sequence"),
    };
}
