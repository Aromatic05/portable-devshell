import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { JsonValue } from "@portable-devshell/shared";
import { CommentService } from "../../src/comment/CommentService.ts";
import { CommentExtension } from "../../src/index.ts";
import type { MailingNotificationIdentity } from "../../src/mailing/Service.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { MESSAGE_DATABASE_SCHEMA_VERSION } from "../../src/message/store/Schema.ts";
import { databaseCapability, databaseConnection } from "../helpers/Database.ts";
import { diskMemory, editsPath, INBOX, mail, OUTBOX, STATE } from "../helpers/DiskMemory.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const identity: MailingNotificationIdentity = {
    instance: "alpha", workspace: "/workspace", ctxId: "owner", mailId: "sender#1", kind: "inbox:receiver",
};
const input = { ctxId: "owner", text: "New Mail\nFrom: sender\nSubject: Durable producer" };

async function producer(t: TestContext) {
    const root = await createTestTempDirectory("mailing-producer");
    const filePath = join(root, "message.sqlite3");
    const stores: MessageStore[] = [];
    const events: Array<{ type: string; data: JsonValue }> = [];
    let afterTransaction: (() => Promise<void>) | undefined;
    let beforeCommit: (() => Promise<void>) | undefined;
    let beforeEvent: (() => Promise<void>) | undefined;
    let beforeEventAck: (() => Promise<void>) | undefined;
    let now = Date.now();
    function open() {
        const store = new MessageStore({ filePath, instanceName: "alpha", now: () => now, retentionDays: 1,
            openDatabase: async () => {
                const db = await databaseConnection(filePath);
                return { ...db,
                    async transaction(work) {
                        const value = await db.transaction(async (connection) => {
                            const value = await work(connection);
                            await beforeCommit?.();
                            return value;
                        });
                        await afterTransaction?.();
                        return value;
                    },
                    async run(sql, values) {
                        if (sql.startsWith("UPDATE mailing_notifications SET queued_event_recorded"))
                            await beforeEventAck?.();
                        return await db.run(sql, values);
                    },
                };
            },
        });
        stores.push(store);
        const service = new CommentService({ instanceName: "alpha", store,
            appendEvent: async (type, data) => {
                await beforeEvent?.();
                events.push({ type, data });
            } });
        return { store, service };
    }
    t.after(async () => { for (const store of stores) await store.close(); });
    const initial = open();
    await initial.service.list();
    const probe = new DatabaseSync(filePath);
    t.after(() => probe.close());
    function counts() {
        return {
            comments: probe.prepare("SELECT COUNT(*) AS n FROM message_entries WHERE kind = 'comment'").get()!.n,
            receipts: probe.prepare("SELECT COUNT(*) AS n FROM mailing_notifications").get()!.n,
        };
    }
    return { ...initial, root, filePath, probe, counts, events, open,
        setAfterTransaction(value: typeof afterTransaction) { afterTransaction = value; },
        setBeforeCommit(value: typeof beforeCommit) { beforeCommit = value; },
        setBeforeEvent(value: typeof beforeEvent) { beforeEvent = value; },
        setBeforeEventAck(value: typeof beforeEventAck) { beforeEventAck = value; },
        advanceDay() { now += 2 * 24 * 60 * 60 * 1000; },
    };
}

test("Mailing Comment and its producer receipt roll back atomically when receipt insertion fails", async (t) => {
    const f = await producer(t);
    await f.store.writeControlState("owner", { pendingReplyCommentId: "previous" });
    f.probe.exec(`CREATE TRIGGER fail_receipt AFTER INSERT ON mailing_notifications
        BEGIN SELECT RAISE(ABORT, 'receipt insertion failed'); END;`);
    await assert.rejects(f.service.queue(input, identity), /receipt insertion failed/u);
    assert.deepEqual(f.counts(), { comments: 0, receipts: 0 });
    assert.deepEqual(await f.store.readControlState("owner"), { pendingReplyCommentId: "previous" });
    assert.deepEqual(f.events, []);
    f.probe.exec("DROP TRIGGER fail_receipt");
    await f.store.close();
    const restarted = f.open();
    const admitted = await restarted.service.queue(input, identity);
    assert.deepEqual(f.counts(), { comments: 1, receipts: 1 });
    assert.equal((await restarted.service.queue(input, identity)).id, admitted.id);
    assert.equal(f.events.length, 1);
});

test("Mailing producer exposes neither a Comment nor its receipt to another connection before commit", async (t) => {
    const f = await producer(t);
    let reached!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { reached = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    f.setBeforeCommit(async () => { reached(); await released; });
    const queued = f.service.queue(input, identity);
    await inside;
    const uncommitted = f.counts();
    release();
    await queued;
    assert.deepEqual(uncommitted, { comments: 0, receipts: 0 });
    assert.deepEqual(f.counts(), { comments: 1, receipts: 1 });
    assert.equal(f.probe.prepare("PRAGMA read_uncommitted").get()!.read_uncommitted, 0);
});

test("Mailing replays a lost SQLite commit response using the original ID after store reopen", async (t) => {
    const f = await producer(t);
    f.setAfterTransaction(async () => {
        f.setAfterTransaction(undefined);
        throw new Error("Transaction response lost after commit");
    });
    await assert.rejects(f.service.queue(input, identity), /Transaction response lost/u);
    assert.deepEqual(f.counts(), { comments: 1, receipts: 1 });
    const original = f.probe.prepare("SELECT id FROM message_entries").get()!.id;
    assert.deepEqual(f.events, []);
    await f.store.close();
    const restarted = f.open();
    const retry = await restarted.service.queue(input, identity);
    assert.equal(retry.id, original);
    assert.deepEqual(f.counts(), { comments: 1, receipts: 1 });
    assert.equal(f.events.length, 1);
    assert.equal((await restarted.service.consumePending("owner", "consume")).messages[0]!.id, original);
    assert.deepEqual((await restarted.service.consumePending("owner", "consume-again")).messages, []);
});

test("Mailing wakeup failure retains a visible Comment and retries its event across restart", async (t) => {
    const f = await producer(t);
    f.setBeforeEvent(async () => {
        f.setBeforeEvent(undefined);
        throw new Error("Queued event unavailable");
    });
    await assert.rejects(f.service.queue(input, identity), /Queued event unavailable/u);
    const original = (await f.service.list("owner"))[0]!;
    assert.equal(original.status, "sent");
    assert.deepEqual(f.counts(), { comments: 1, receipts: 1 });
    await f.store.close();
    const restarted = f.open();
    assert.equal((await restarted.service.queue(input, identity)).id, original.id);
    assert.equal(f.events.length, 1);
    assert.equal(f.probe.prepare("SELECT queued_event_recorded FROM mailing_notifications").get()!.queued_event_recorded, 1);
    assert.equal((await restarted.service.queue(input, identity)).id, original.id);
    assert.equal(f.events.length, 1);
});

test("Mailing retries an uncertain queued-event acknowledgement without resurrecting a consumed Comment", async (t) => {
    const f = await producer(t);
    f.setBeforeEventAck(async () => {
        f.setBeforeEventAck(undefined);
        throw new Error("Event acknowledgement unavailable");
    });
    await assert.rejects(f.service.queue(input, identity), /Event acknowledgement unavailable/u);
    const delivered = await f.service.consumePending("owner", "consume-before-retry");
    assert.equal(delivered.messages.length, 1);
    await f.store.close();
    const restarted = f.open();
    const retried = await restarted.service.queue(input, identity);
    assert.equal(retried.id, delivered.messages[0]!.id);
    assert.equal((await restarted.service.list("owner"))[0]!.status, "delivered");
    assert.deepEqual((await restarted.service.consumePending("owner", "retry")).messages, []);
    assert.deepEqual(f.counts(), { comments: 1, receipts: 1 });
    assert.deepEqual(f.events.filter(({ type }) => type === "context.message.queued").map(({ data }) =>
        (data as Record<string, JsonValue>).id), [retried.id, retried.id]);
});

test("Mailing durable producer receipts survive terminal-history retention and store reopen", async (t) => {
    const f = await producer(t);
    const first = await f.service.queue(input, identity);
    await f.service.consumePending("owner", "delivered");
    await f.store.appendReport({ ctxId: "owner", callId: "report", createdAt: new Date().toISOString(),
        replyCommentId: first.id, text: "Acknowledged delivery" });
    await f.store.close();
    f.advanceDay();
    const restarted = f.open();
    assert.deepEqual(await restarted.service.list("owner"), []);
    assert.deepEqual(f.counts(), { comments: 0, receipts: 1 });
    assert.deepEqual(await restarted.service.queue(input, identity), first);
    assert.deepEqual(f.counts(), { comments: 0, receipts: 1 });
    assert.deepEqual((await restarted.service.consumePending("owner", "after-retention")).messages, []);
    assert.equal(f.events.filter(({ type }) => type === "context.message.queued").length, 1);
});

test("Mailing exact producer identities distinguish Workspace, Context, mail ID and kind without text dedupe", async (t) => {
    const f = await producer(t);
    const keys = [identity, { ...identity, workspace: "/other" }, { ...identity, ctxId: "successor" },
        { ...identity, mailId: "sender#8" }, { ...identity, kind: "bounce:receiver" }];
    const ids: string[] = [];
    for (const key of keys) ids.push((await f.service.queue({ ...input, ctxId: key.ctxId }, key)).id);
    for (const key of keys) await f.service.queue({ ...input, ctxId: key.ctxId }, key);
    assert.equal(new Set(ids).size, keys.length);
    assert.deepEqual(f.counts(), { comments: 5, receipts: 5 });
    await assert.rejects(f.service.queue({ ...input, text: "Changed payload" }, identity), /payload changed/u);
    await assert.rejects(f.service.queue(input, { ...identity, ctxId: "wrong-context" }), /scope/u);
    await assert.rejects(f.service.queue(input, { ...identity, instance: "wrong-instance" }), /scope/u);
    assert.deepEqual(f.counts(), { comments: 5, receipts: 5 });
});

test("CommentExtension forwards producer identity through the real Instance binding independently", async (t) => {
    const root = await createTestTempDirectory("mailing-instance-binding");
    const events: JsonValue[] = [];
    function create() {
        return new CommentExtension({
            instances: {
                list: () => ["alpha", "beta"].map((name) => ({ name, key: {}, enabled: true,
                    messageDatabaseFile: join(root, `${name}.sqlite3`),
                    appendEvent: async (_type, data) => { events.push(data); } })),
                onChange: () => () => {},
            },
            database: databaseCapability((name) => join(root, name === "message-preferences" ? "preferences.sqlite3"
                : `${name.split("/")[1]}.sqlite3`)),
            preferencesFile: join(root, "preferences.json"),
        });
    }
    const first = create();
    await first.comment.queue("alpha", "owner", input.text, identity);
    await first.comment.queue("beta", "owner", input.text, { ...identity, instance: "beta" });
    await first.close();
    const next = create();
    t.after(() => next.close());
    await next.comment.queue("alpha", "owner", input.text, identity);
    await next.comment.queue("beta", "owner", input.text, { ...identity, instance: "beta" });
    const left = await next.messageHistory.list("alpha", { ctxId: "owner" });
    const right = await next.messageHistory.list("beta", { ctxId: "owner" });
    assert.equal(left.length, 1);
    assert.equal(right.length, 1);
    assert.notEqual(left[0]!.id, right[0]!.id);
    assert.equal(events.length, 2);
});

test("Mailing producer transport uncertainty retries one durable Comment after both services reopen", async (t) => {
    const f = await diskMemory(t);
    const service = f.newMailing();
    await service.init(f.owner, "receiver");
    await f.put(OUTBOX, mail());
    f.setBeforeNotice(async () => {
        f.setBeforeNotice(undefined);
        f.setBeforeTool(async (name, value) => {
            if (name === "file_edit" && editsPath(value, STATE)) {
                f.setBeforeTool(undefined);
                throw new Error("ACK unavailable after notification commit");
            }
        });
    });
    await assert.rejects(service.scan(f.target), /ACK unavailable/u);
    const original = (await f.comment.list("owner"))[0]!;
    await f.comment.consumePending("owner", "consumed-before-replay");
    await service.close();
    await f.restartComment();
    const next = f.newMailing();
    await next.poll();
    await next.poll();
    assert.deepEqual((await f.comment.list("owner")).map(({ id, status }) => ({ id, status })),
        [{ id: original.id, status: "delivered" }]);
    assert.deepEqual((await f.comment.consumePending("owner", "second-consume")).messages, []);
    assert.equal((await f.read(INBOX)).split("Original body α").length - 1, 1);
    assert.deepEqual(JSON.parse(await f.read(STATE)).pendingNotices, {});
});

test("Mailing schema v2 upgrades atomically, preserving history, controls and durable receipts on reopen", async (t) => {
    const root = await createTestTempDirectory("mailing-schema-upgrade");
    const filePath = join(root, "message.sqlite3");
    const seed = new DatabaseSync(filePath);
    seed.exec(`CREATE TABLE message_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL, ctx_id TEXT NOT NULL,
        created_at TEXT NOT NULL, text TEXT NOT NULL, status TEXT, call_id TEXT, delivered_at TEXT,
        failed_at TEXT, error TEXT, UNIQUE(kind, id)) STRICT;
        CREATE TABLE message_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        INSERT INTO message_entries(kind,id,ctx_id,created_at,text,status)
        VALUES ('comment','historical','owner','2026-10-20T00:00:00Z','Original history','sent');
        INSERT INTO message_metadata VALUES ('sentinel','original metadata');
        PRAGMA user_version = 2;`);
    seed.close();
    const store = new MessageStore({ filePath, instanceName: "alpha", openDatabase: () => databaseConnection(filePath) });
    t.after(() => store.close());
    assert.deepEqual((await store.list()).map(({ id, text }) => ({ id, text })),
        [{ id: "historical", text: "Original history" }]);
    const db = new DatabaseSync(filePath);
    t.after(() => db.close());
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, MESSAGE_DATABASE_SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT value FROM message_metadata WHERE key = 'sentinel'").get()!.value, "original metadata");
    const service = new CommentService({ store, instanceName: "alpha", appendEvent: async () => {} });
    const admitted = await service.queue(input, identity);
    await store.close();
    assert.equal((await service.queue(input, identity)).id, admitted.id);
    assert.equal((await service.list()).length, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mailing_notifications").get()!.n, 1);
});

test("Mailing schema upgrade rolls back DDL and version together when migration is interrupted", async (t) => {
    const root = await createTestTempDirectory("mailing-schema-rollback");
    const filePath = join(root, "message.sqlite3");
    const initialized = new MessageStore({ filePath, instanceName: "alpha", openDatabase: () => databaseConnection(filePath) });
    await initialized.list();
    await initialized.close();
    const probe = new DatabaseSync(filePath);
    t.after(() => probe.close());
    probe.exec("DROP TABLE mailing_notifications; PRAGMA user_version = 2;");
    const interrupted = new MessageStore({ filePath, instanceName: "alpha", openDatabase: async () => {
        const db = await databaseConnection(filePath);
        return { ...db, async transaction(work) {
            return await db.transaction((connection) => work({ ...connection, async exec(sql) {
                await connection.exec(sql);
                if (sql.includes("CREATE TABLE IF NOT EXISTS mailing_notifications"))
                    throw new Error("Migration interrupted after DDL");
            } }));
        } };
    } });
    await assert.rejects(interrupted.list(), /Migration interrupted after DDL/u);
    await interrupted.close();
    assert.equal(probe.prepare("PRAGMA user_version").get()!.user_version, 2);
    assert.equal(probe.prepare("SELECT name FROM sqlite_master WHERE name = 'mailing_notifications'").get(), undefined);
    const restarted = new MessageStore({ filePath, instanceName: "alpha", openDatabase: () => databaseConnection(filePath) });
    t.after(() => restarted.close());
    const service = new CommentService({ instanceName: "alpha", store: restarted, appendEvent: async () => {} });
    await service.queue(input, identity);
    assert.equal(probe.prepare("PRAGMA user_version").get()!.user_version, MESSAGE_DATABASE_SCHEMA_VERSION);
    assert.equal(probe.prepare("SELECT COUNT(*) AS n FROM mailing_notifications").get()!.n, 1);
});

for (const [boundary, exitCode, eventRecorded] of [["admission", 31, 0], ["event-ack", 32, 1]] as const) {
    test(`Mailing producer survives a real process exit at ${boundary} before the caller receives success`, async (t) => {
        const root = await createTestTempDirectory("mailing-producer-crash");
        const filePath = join(root, "message.sqlite3");
        const crash = spawnSync(process.execPath, ["--import", "tsx", "--import",
            new URL("../RegisterWorkspacePackages.mjs", import.meta.url).href,
            fileURLToPath(new URL("../helpers/MailingCrashProcess.ts", import.meta.url)), filePath, boundary],
            { encoding: "utf8", env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../../tsconfig.test.json", import.meta.url)) } });
        assert.equal(crash.status, exitCode, crash.stderr);
        const probe = new DatabaseSync(filePath);
        t.after(() => probe.close());
        const receipt = probe.prepare("SELECT comment_id, queued_event_recorded FROM mailing_notifications").get()!;
        assert.equal(receipt.queued_event_recorded, eventRecorded);
        const store = new MessageStore({ filePath, instanceName: "alpha", openDatabase: () => databaseConnection(filePath) });
        t.after(() => store.close());
        const events: JsonValue[] = [];
        const service = new CommentService({ store, instanceName: "alpha", appendEvent: async (_type, data) => { events.push(data); } });
        assert.equal((await service.queue(input, identity)).id, receipt.comment_id);
        assert.equal((await service.list("owner")).length, 1);
        assert.equal(probe.prepare("SELECT COUNT(*) AS n FROM mailing_notifications").get()!.n, 1);
        assert.equal(events.length, 1 - eventRecorded);
        assert.equal((await service.consumePending("owner", "consume")).messages[0]!.id, receipt.comment_id);
        assert.deepEqual((await service.consumePending("owner", "consume-again")).messages, []);
    });
}

test("Independent producer processes admit the same full identity into SQLite only once", async (t) => {
    const f = await producer(t);
    await f.store.close();
    function run() {
        return new Promise<{ code: number | null; id: string; error: string }>((resolve, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", "--import",
                new URL("../RegisterWorkspacePackages.mjs", import.meta.url).href,
                fileURLToPath(new URL("../helpers/MailingCrashProcess.ts", import.meta.url)), f.filePath, "success"],
                { env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../../tsconfig.test.json", import.meta.url)) } });
            let id = "";
            let error = "";
            child.stdout.on("data", (chunk: Buffer) => { id += chunk.toString(); });
            child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
            child.once("error", reject);
            child.once("close", (code) => resolve({ code, id, error }));
        });
    }
    const [left, right] = await Promise.all([run(), run()]);
    assert.equal(left.code, 0, left.error);
    assert.equal(right.code, 0, right.error);
    assert.match(left.id, /^message-/u);
    assert.equal(left.id, right.id);
    assert.deepEqual(f.counts(), { comments: 1, receipts: 1 });
});
