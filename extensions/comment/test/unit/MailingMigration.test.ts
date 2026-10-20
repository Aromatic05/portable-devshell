import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { CommentService } from "../../src/comment/CommentService.ts";
import { migrateMessageDatabase } from "../../src/message/migration/index.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { databaseConnection } from "../helpers/Database.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const identity = { instance: "alpha", workspace: "/workspace", ctxId: "owner", mailId: "sender#1", kind: "inbox:receiver" };
const notice = { ctxId: "owner", text: "New Mail\nFrom: sender\nSubject: Migrated producer" };
const importMarker = "migration.legacy-conversation-imported";
const receiptMarker = "migration.legacy-mailing-notifications-imported";

async function migrationFixture(t: TestContext) {
    const root = await createTestTempDirectory("mailing-merge");
    function client(name: string) {
        const file = join(root, `${name}.sqlite3`);
        const store = new MessageStore({ filePath: file, instanceName: "alpha", openDatabase: () => databaseConnection(file) });
        const events: unknown[] = [];
        const service = new CommentService({ instanceName: "alpha", store, appendEvent: async (_type, data) => { events.push(data); } });
        t.after(() => store.close());
        return { file, store, service, events };
    }
    const source = client("source");
    const target = client("target");
    await source.store.list();
    await target.store.list();
    await source.store.close();
    await target.store.close();
    const migrate = () => migrateMessageDatabase({ instance: "alpha", sourceFile: source.file, targetFile: target.file });
    return { source, target, migrate };
}

function execute(file: string, sql: string): void {
    const db = new DatabaseSync(file);
    try {
        db.exec(sql);
    } finally {
        db.close();
    }
}

function rows(file: string, sql: string) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        return db.prepare(sql).all().map((row) => ({ ...row }));
    } finally {
        db.close();
    }
}

for (const acknowledged of [0, 1]) {
    test(`Mailing v3 merge preserves identity, visibility and queued acknowledgement ${acknowledged} across restarts`, async (t) => {
        const { source, target, migrate } = await migrationFixture(t);
        const original = await source.service.queue(notice, identity);
        const current = await target.service.queue({ ctxId: "owner", text: "Current comment" });
        await source.store.close();
        await target.store.close();
        execute(source.file, `UPDATE mailing_notifications SET queued_event_recorded = ${acknowledged}`);
        const originalBytes = readFileSync(source.file);

        await migrate();
        await migrate();
        target.events.length = 0;
        assert.equal((await target.service.queue(notice, identity)).id, original.id);
        assert.equal(target.events.length, 1 - acknowledged);
        assert.deepEqual(new Set((await target.service.list()).map(({ id }) => id)), new Set([original.id, current.id]));
        assert.deepEqual(new Set((await target.service.consumePending("owner", "consume")).messages.map(({ id }) => id)),
            new Set([original.id, current.id]));
        await target.store.close();
        await migrate();
        target.events.length = 0;
        assert.equal((await target.service.queue(notice, identity)).id, original.id);
        assert.equal(target.events.length, 0);
        assert.deepEqual((await target.service.consumePending("owner", "consume-again")).messages, []);
        assert.deepEqual(rows(target.file, "SELECT comment_id, queued_event_recorded FROM mailing_notifications"),
            [{ comment_id: original.id, queued_event_recorded: 1 }]);
        assert.deepEqual(readFileSync(source.file), originalBytes);
    });
}

for (const legacy of [
    { name: "v1 without optional metadata", sql: "DROP TABLE mailing_notifications; ALTER TABLE message_entries RENAME TO conversation_entries; DROP TABLE message_metadata; PRAGMA user_version = 1;", metadata: [] },
    { name: "v1 with metadata", sql: "DROP TABLE mailing_notifications; ALTER TABLE message_entries RENAME TO conversation_entries; ALTER TABLE message_metadata RENAME TO conversation_metadata; PRAGMA user_version = 1;", metadata: [{ value: "original metadata" }] },
    { name: "v2", sql: "DROP TABLE mailing_notifications; PRAGMA user_version = 2;", metadata: [{ value: "original metadata" }] },
]) {
    test(`Mailing merges valid ${legacy.name} into an existing v3 target without changing its source`, async (t) => {
        const { source, target, migrate } = await migrationFixture(t);
        const historical = await source.service.queue({ ctxId: "owner", text: "Legacy comment" });
        await source.store.close();
        execute(source.file, `INSERT INTO message_metadata VALUES ('sentinel', 'original metadata'); ${legacy.sql}`);
        const originalBytes = readFileSync(source.file);
        await migrate();
        await migrate();
        assert.deepEqual((await target.service.list()).map(({ id }) => id), [historical.id]);
        assert.deepEqual(rows(target.file, "SELECT value FROM message_metadata WHERE key = 'sentinel'"), legacy.metadata);
        assert.deepEqual((await target.service.consumePending("owner", "consume")).messages.map(({ id }) => id), [historical.id]);
        await target.store.close();
        execute(target.file, "DELETE FROM message_entries");
        await migrate();
        assert.deepEqual(await target.service.list(), []);
        assert.deepEqual(readFileSync(source.file), originalBytes);
    });
}

for (const history of [
    { name: "visible", cleanup: "", count: 1 },
    { name: "compacted", cleanup: "DELETE FROM message_entries;", count: 0 },
]) {
    test(`Mailing repairs receipts after an older merge marker while preserving ${history.name} history`, async (t) => {
        const { source, target, migrate } = await migrationFixture(t);
        const original = await source.service.queue(notice, identity);
        await source.store.close();
        const originalBytes = readFileSync(source.file);
        // Reproduce the old merge: the Comment and completion marker were
        // imported, but its durable Mailing identity was not.
        await target.store.insertComment(original);
        await target.store.close();
        execute(target.file, `INSERT INTO message_metadata VALUES ('${importMarker}', 'source.sqlite3'); ${history.cleanup}`);
        await migrate();
        await migrate();
        assert.equal((await target.service.queue(notice, identity)).id, original.id);
        assert.equal((await target.service.list()).length, history.count);
        assert.equal(target.events.length, 0);
        assert.deepEqual(rows(target.file, `SELECT value FROM message_metadata WHERE key = '${receiptMarker}'`),
            [{ value: "source.sqlite3" }]);
        await target.store.close();
        execute(target.file, "DELETE FROM message_entries");
        await migrate();
        assert.equal((await target.service.queue(notice, identity)).id, original.id);
        assert.deepEqual(await target.service.list(), []);
        assert.deepEqual(readFileSync(source.file), originalBytes);
    });
}

test("Mailing merges a receipt whose source Comment expired without resurrecting history on replay", async (t) => {
    const { source, target, migrate } = await migrationFixture(t);
    const original = await source.service.queue(notice, identity);
    await source.service.consumePending("owner", "delivered-before-expiry");
    await source.store.close();
    execute(source.file, "DELETE FROM message_entries");
    const originalBytes = readFileSync(source.file);
    await migrate();
    assert.equal((await target.service.queue(notice, identity)).id, original.id);
    assert.deepEqual(await target.service.list(), []);
    assert.equal(target.events.length, 0);
    await target.store.close();
    await migrate();
    assert.equal((await target.service.queue(notice, identity)).id, original.id);
    assert.deepEqual(await target.service.list(), []);
    assert.deepEqual(readFileSync(source.file), originalBytes);
});

test("Mailing first merge respects a matching target receipt whose Comment was already compacted", async (t) => {
    const { source, target, migrate } = await migrationFixture(t);
    const original = await source.service.queue(notice, identity);
    await source.store.close();
    await target.store.insertComment(original, identity);
    await target.store.acknowledgeQueuedEvent(identity);
    await target.service.consumePending("owner", "delivered-before-expiry");
    await target.store.close();
    execute(target.file, "DELETE FROM message_entries");
    target.events.length = 0;
    const originalBytes = readFileSync(source.file);
    await migrate();
    assert.deepEqual(await target.service.list(), []);
    assert.equal((await target.service.queue(notice, identity)).id, original.id);
    assert.deepEqual((await target.service.consumePending("owner", "replay-after-expiry")).messages, []);
    assert.equal(target.events.length, 0);
    await target.store.close();
    await migrate();
    assert.deepEqual(await target.service.list(), []);
    assert.deepEqual(readFileSync(source.file), originalBytes);
});

for (const [sourceAck, targetAck] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
    test(`Mailing merges an identical receipt using durable acknowledgements ${sourceAck}/${targetAck}`, async (t) => {
        const { source, target, migrate } = await migrationFixture(t);
        const original = await source.service.queue(notice, identity);
        await target.store.insertComment(original, identity);
        await source.store.close();
        await target.store.close();
        execute(source.file, `UPDATE mailing_notifications SET queued_event_recorded = ${sourceAck}`);
        execute(target.file, `UPDATE mailing_notifications SET queued_event_recorded = ${targetAck}`);
        const originalBytes = readFileSync(source.file);
        await migrate();
        assert.deepEqual(rows(target.file, "SELECT queued_event_recorded FROM mailing_notifications"),
            [{ queued_event_recorded: Math.max(sourceAck, targetAck) }]);
        assert.equal((await target.service.queue(notice, identity)).id, original.id);
        assert.equal(target.events.length, 1 - Math.max(sourceAck, targetAck));
        assert.deepEqual((await target.service.list()).map(({ id }) => id), [original.id]);
        await target.store.close();
        await migrate();
        target.events.length = 0;
        assert.equal((await target.service.queue(notice, identity)).id, original.id);
        assert.equal(target.events.length, 0);
        assert.deepEqual(readFileSync(source.file), originalBytes);
    });
}

for (const collision of [
    { name: "identity bound to another Comment", record: { id: "other-comment" }, key: identity },
    { name: "Comment bound to another identity", record: {}, key: { ...identity, mailId: "sender#other" } },
    { name: "Comment ID with another payload", record: { text: "Unrelated payload" }, key: undefined },
    { name: "Comment ID in another Context", record: { ctxId: "other-context" }, key: undefined },
    { name: "Comment ID from another admission time", record: { createdAt: "2026-10-19T00:00:00Z" }, key: undefined },
    { name: "compacted Comment ID with another payload", record: { text: "Unrelated compacted payload" }, key: identity, cleanup: "DELETE FROM message_entries" },
]) {
    test(`Mailing aborts and rolls back entries, receipts, metadata and markers on ${collision.name}`, async (t) => {
        const { source, target, migrate } = await migrationFixture(t);
        await source.service.queue({ ctxId: "owner", text: "Must roll back this earlier insertion" }, { ...identity, mailId: "sender#earlier" });
        const original = await source.service.queue(notice, identity);
        await source.store.close();
        execute(source.file, "INSERT INTO message_metadata VALUES ('source-sentinel', 'must roll back')");
        const originalBytes = readFileSync(source.file);
        await target.store.insertComment({ ...original, ...collision.record }, collision.key);
        await target.store.close();
        execute(target.file, collision.cleanup ?? "");
        const before = snapshot(target.file);
        await assert.rejects(migrate(), /Legacy Mailing migration conflict.*rolled back/u);
        assert.deepEqual(snapshot(target.file), before);
        await assert.rejects(migrate(), /Legacy Mailing migration conflict.*rolled back/u);
        assert.deepEqual(snapshot(target.file), before);
        assert.deepEqual(readFileSync(source.file), originalBytes);
    });
}

test("Mailing rolls back the whole merge after receipt insertion fails and succeeds after restart", async (t) => {
    const { source, target, migrate } = await migrationFixture(t);
    const original = await source.service.queue(notice, identity);
    await source.store.close();
    execute(source.file, "INSERT INTO message_metadata VALUES ('source-sentinel', 'retained metadata')");
    const originalBytes = readFileSync(source.file);
    execute(target.file, `CREATE TRIGGER interrupt_receipt AFTER INSERT ON mailing_notifications
        BEGIN SELECT RAISE(ABORT, 'Injected receipt write failure'); END;`);
    const before = snapshot(target.file);
    await assert.rejects(migrate(), /Injected receipt write failure/u);
    assert.deepEqual(snapshot(target.file), before);
    execute(target.file, "DROP TRIGGER interrupt_receipt");
    await migrate();
    await migrate();
    assert.equal((await target.service.queue(notice, identity)).id, original.id);
    assert.deepEqual((await target.service.list()).map(({ id }) => id), [original.id]);
    assert.deepEqual(rows(target.file, "SELECT value FROM message_metadata WHERE key = 'source-sentinel'"),
        [{ value: "retained metadata" }]);
    assert.deepEqual(readFileSync(source.file), originalBytes);
});

test("Mailing receipt migration completion failure rolls back imported history and acknowledgements", async (t) => {
    const { source, target, migrate } = await migrationFixture(t);
    const original = await source.service.queue(notice, identity);
    await source.store.close();
    await target.store.insertComment(original, identity);
    await target.store.close();
    execute(target.file, `CREATE TRIGGER interrupt_marker BEFORE INSERT ON message_metadata
        WHEN NEW.key = '${receiptMarker}' BEGIN SELECT RAISE(ABORT, 'Injected marker write failure'); END;`);
    const originalBytes = readFileSync(source.file);
    const before = snapshot(target.file);
    await assert.rejects(migrate(), /Injected marker write failure/u);
    assert.deepEqual(snapshot(target.file), before);
    execute(target.file, "DROP TRIGGER interrupt_marker");
    await migrate();
    assert.equal((await target.service.queue(notice, identity)).id, original.id);
    assert.equal(target.events.length, 0);
    assert.deepEqual(readFileSync(source.file), originalBytes);
});

test("Mailing source migration markers cannot suppress importing that source's receipts", async (t) => {
    const { source, target, migrate } = await migrationFixture(t);
    const original = await source.service.queue(notice, identity);
    await source.store.close();
    execute(source.file, `INSERT INTO message_metadata VALUES ('${importMarker}', 'earlier-source.sqlite3'),
        ('${receiptMarker}', 'earlier-source.sqlite3');`);
    const originalBytes = readFileSync(source.file);
    await migrate();
    assert.equal((await target.service.queue(notice, identity)).id, original.id);
    assert.deepEqual(rows(target.file, `SELECT value FROM message_metadata WHERE key IN ('${importMarker}', '${receiptMarker}') ORDER BY key`),
        [{ value: "source.sqlite3" }, { value: "source.sqlite3" }]);
    assert.deepEqual(readFileSync(source.file), originalBytes);
});

test("Mailing v3 receipts cannot be silently dropped when the target has not upgraded yet", async (t) => {
    const { source, target, migrate } = await migrationFixture(t);
    const original = await source.service.queue(notice, identity);
    const current = await target.service.queue({ ctxId: "owner", text: "Current v2 comment" });
    await source.store.close();
    await target.store.close();
    execute(target.file, "DROP TABLE mailing_notifications; PRAGMA user_version = 2;");
    const originalBytes = readFileSync(source.file);
    const targetBytes = readFileSync(target.file);
    await assert.rejects(migrate(), /receipts require an upgraded target/u);
    assert.deepEqual(readFileSync(target.file), targetBytes);
    await target.store.list();
    await target.store.close();
    await migrate();
    assert.equal((await target.service.queue(notice, identity)).id, original.id);
    assert.deepEqual(new Set((await target.service.list()).map(({ id }) => id)), new Set([original.id, current.id]));
    assert.deepEqual(readFileSync(source.file), originalBytes);
});

test("Mailing can merge into a valid v1 target without metadata before its schema upgrade", async (t) => {
    const { source, target, migrate } = await migrationFixture(t);
    const original = await source.service.queue({ ctxId: "owner", text: "Legacy Comment" });
    await source.store.close();
    const downgrade = "DROP TABLE mailing_notifications; ALTER TABLE message_entries RENAME TO conversation_entries; DROP TABLE message_metadata; PRAGMA user_version = 1;";
    execute(source.file, downgrade);
    execute(target.file, downgrade);
    const originalBytes = readFileSync(source.file);
    await migrate();
    await migrate();
    assert.deepEqual((await target.service.list()).map(({ id }) => id), [original.id]);
    await target.store.close();
    await migrate();
    assert.deepEqual((await target.service.list()).map(({ id }) => id), [original.id]);
    assert.deepEqual(readFileSync(source.file), originalBytes);
});

for (const invalid of [
    { name: "v1 missing entries", sql: "DROP TABLE mailing_notifications; DROP TABLE message_entries; ALTER TABLE message_metadata RENAME TO conversation_metadata; PRAGMA user_version = 1;", error: /missing conversation_entries/u },
    { name: "v2 missing metadata", sql: "DROP TABLE mailing_notifications; DROP TABLE message_metadata; PRAGMA user_version = 2;", error: /missing message_metadata/u },
    { name: "v3 missing receipts", sql: "DROP TABLE mailing_notifications;", error: /missing mailing_notifications/u },
    { name: "v1 malformed optional metadata", sql: "DROP TABLE mailing_notifications; ALTER TABLE message_entries RENAME TO conversation_entries; DROP TABLE message_metadata; CREATE TABLE conversation_metadata (unexpected TEXT); PRAGMA user_version = 1;", error: /no such column/u },
    { name: "unsupported schema", sql: "PRAGMA user_version = 4;", error: /Unsupported legacy message database schema 4/u },
]) {
    test(`Mailing refuses ${invalid.name} without modifying either database`, async (t) => {
        const { source, target, migrate } = await migrationFixture(t);
        execute(source.file, invalid.sql);
        const sourceBytes = readFileSync(source.file);
        const before = snapshot(target.file);
        await assert.rejects(migrate(), invalid.error);
        assert.deepEqual(snapshot(target.file), before);
        assert.deepEqual(readFileSync(source.file), sourceBytes);
    });
}

function snapshot(file: string) {
    return {
        entries: rows(file, "SELECT * FROM message_entries ORDER BY seq"),
        receipts: rows(file, "SELECT * FROM mailing_notifications ORDER BY comment_id"),
        metadata: rows(file, "SELECT * FROM message_metadata ORDER BY key"),
        sequence: rows(file, "SELECT * FROM sqlite_sequence"),
    };
}

test("Mailing schema upgrade remains compatible with a retained legacy source on the next startup", async (t) => {
    const root = await createTestTempDirectory("mailing-retained-legacy-source");
    const sourceFile = join(root, "legacy.sqlite3");
    const targetFile = join(root, "message.sqlite3");
    const source = new MessageStore({ filePath: sourceFile, instanceName: "alpha", openDatabase: () => databaseConnection(sourceFile) });
    const previous = new CommentService({ instanceName: "alpha", store: source, appendEvent: async () => {} });
    const historical = await previous.queue({ ctxId: "owner", text: "Retained historical source" });
    await source.close();
    const old = new DatabaseSync(sourceFile);
    old.exec("DROP TABLE mailing_notifications; PRAGMA user_version = 2;");
    old.close();
    const target = new MessageStore({ filePath: targetFile, instanceName: "alpha", openDatabase: () => databaseConnection(targetFile) });
    const current = new CommentService({ instanceName: "alpha", store: target, appendEvent: async () => {} });
    const key = { instance: "alpha", workspace: "/workspace", ctxId: "owner", mailId: "sender#1", kind: "inbox:receiver" };
    const notice = { ctxId: "owner", text: "New Mail\nFrom: sender\nSubject: Current producer" };
    const admitted = await current.queue(notice, key);
    await target.close();
    t.after(() => target.close());
    await migrateMessageDatabase({ instance: "alpha", sourceFile, targetFile });
    await migrateMessageDatabase({ instance: "alpha", sourceFile, targetFile });
    assert.deepEqual(new Set((await current.list()).map(({ id }) => id)), new Set([historical.id, admitted.id]));
    assert.equal((await current.queue(notice, key)).id, admitted.id);
    assert.equal((await current.list()).length, 2);
});
