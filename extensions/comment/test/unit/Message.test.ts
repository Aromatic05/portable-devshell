import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import {
    MESSAGE_DATABASE_SCHEMA_VERSION,
    defaultMessageStorageLimits,
} from "../../src/message/store/Schema.ts";
import { MessageService } from "../../src/message/MessageService.ts";

test("MessageStore migrates v1 conversation table names once", async () => {
    const root = await createTestTempDirectory("message-database-v1-migration");
    const databaseFile = join(root, "message.sqlite3");
    createLegacyMessageDatabaseV1(databaseFile);

    const store = new MessageStore({
        filePath: databaseFile,
        instanceName: "alpha",
    });
    assert.deepEqual(
        store.listComments().map(({ ctxId, id, text }) => ({ ctxId, id, text })),
        [{ ctxId: "ctx-legacy", id: "legacy-comment", text: "Legacy message" }],
    );
    assert.equal(readUserVersion(databaseFile), MESSAGE_DATABASE_SCHEMA_VERSION);
    store.close();
});

test("MessageStore clears only the #push snapshot acknowledged by a report", async () => {
    const root = await createTestTempDirectory("message-report-push-cas");
    const store = new MessageStore({
        filePath: join(root, "message.sqlite3"),
        instanceName: "alpha",
    });
    store.insertComment({
        createdAt: "2026-09-20T08:15:17.222Z",
        ctxId: "ctx-a",
        deliveredAt: "2026-09-20T08:15:17.233Z",
        id: "push-1",
        instance: "alpha",
        status: "delivered",
        text: "#push 报告进度",
    });
    const observed = store.readControlState("ctx-a");
    assert.equal(observed.pendingPushCommentId, "push-1");
    assert.equal(observed.pushMessage, "#push 报告进度");

    store.insertComment({
        createdAt: "2026-09-20T08:15:18.222Z",
        ctxId: "ctx-a",
        deliveredAt: "2026-09-20T08:15:18.233Z",
        id: "follow-up-1",
        instance: "alpha",
        status: "delivered",
        text: "还要说明阻塞点",
    });
    store.appendReport({
        callId: "report-old",
        createdAt: "2026-09-20T08:15:19.000Z",
        ctxId: "ctx-a",
        push: {
            commentId: observed.pendingPushCommentId!,
            message: observed.pushMessage!,
        },
        text: "旧 snapshot 的报告",
    });
    assert.deepEqual(store.readControlState("ctx-a"), {
        pendingPushCommentId: "push-1",
        pendingReplyCommentId: "follow-up-1",
        pushMessage: "#push 报告进度\n\n还要说明阻塞点",
        pushToolCallsRemaining: 4,
    });

    const current = store.readControlState("ctx-a");
    store.appendReport({
        callId: "report-current",
        createdAt: "2026-09-20T08:15:20.000Z",
        ctxId: "ctx-a",
        push: {
            commentId: current.pendingPushCommentId!,
            message: current.pushMessage!,
        },
        replyCommentId: current.pendingReplyCommentId,
        text: "当前 snapshot 的报告",
    });
    assert.deepEqual(store.readControlState("ctx-a"), {});
    store.close();
});

test("MessageStore rejects a newer schema without modifying it", async () => {
    const root = await createTestTempDirectory("message-future-schema");
    const databaseFile = join(root, "message.sqlite3");
    createFutureDatabase(
        databaseFile,
        MESSAGE_DATABASE_SCHEMA_VERSION + 1,
    );
    const before = readFutureDatabase(databaseFile);
    const store = new MessageStore({
        filePath: databaseFile,
        instanceName: "alpha",
    });

    assert.throws(
        () => store.list(),
        (error: unknown) => {
            const message = String((error as Error).message);
            assert.match(message, /newer than the supported version/u);
            assert.match(message, /Upgrade portable-devshell/u);
            assert.match(message, /database was not modified/iu);
            return true;
        },
    );
    assert.deepEqual(readFutureDatabase(databaseFile), before);
});

test("MessageStore defaults to a 512 MiB fuse and 90 day retention", () => {
    assert.deepEqual(defaultMessageStorageLimits, {
        maxBytes: 512 * 1024 * 1024,
        retentionDays: 90,
    });
});

test("MessageStore retention removes old terminal history but never old pending or sent Comments", async () => {
    const root = await createTestTempDirectory("message-retention");
    const store = new MessageStore({
        filePath: join(root, "message.sqlite3"),
        instanceName: "alpha",
        now: () => Date.parse("2026-09-11T00:00:00.000Z"),
        retentionDays: 30,
    });
    store.appendReport({
        callId: "old-report",
        createdAt: "2026-07-01T00:00:00.000Z",
        ctxId: "ctx-a",
        text: "expired report",
    });
    store.insertComment({
        createdAt: "2026-07-01T00:00:00.000Z",
        ctxId: "ctx-a",
        deliveredAt: "2026-07-01T00:01:00.000Z",
        id: "old-delivered",
        instance: "alpha",
        status: "delivered",
        text: "expired delivered comment",
    });
    store.insertComment({
        createdAt: "2026-07-01T00:00:00.000Z",
        ctxId: "ctx-a",
        id: "old-sent",
        instance: "alpha",
        status: "sent",
        text: "must survive until delivered or failed",
    });
    store.insertComment({
        createdAt: "2026-07-01T00:00:00.000Z",
        ctxId: "ctx-a",
        deliveredAt: "2026-09-10T00:00:00.000Z",
        id: "recently-delivered",
        instance: "alpha",
        status: "delivered",
        text: "retention starts from terminal time",
    });
    store.appendReport({
        callId: "recent-report",
        createdAt: "2026-09-10T00:00:00.000Z",
        ctxId: "ctx-a",
        text: "recent report",
    });

    assert.deepEqual(
        store.list().map((entry) => entry.id),
        ["old-sent", "recently-delivered", "recent-report"],
    );
    assert.equal(store.stats().protectedComments, 1);
    store.close();
});

test("MessageStore preserves a delivered Comment while control state still needs it as the reply target", async () => {
    const root = await createTestTempDirectory(
        "message-reply-target-retention",
    );
    const store = new MessageStore({
        filePath: join(root, "message.sqlite3"),
        instanceName: "alpha",
        maxBytes: 1_024,
        now: () => Date.parse("2026-09-11T00:00:00.000Z"),
        retentionDays: 30,
    });
    store.insertComment({
        createdAt: "2026-07-01T00:00:00.000Z",
        ctxId: "ctx-a",
        id: "reply-target",
        instance: "alpha",
        status: "sent",
        text: "question ".repeat(1_000),
    });

    store.deliverComments("ctx-a", "delivery-call", "2026-07-01T00:01:00.000Z");

    assert.equal(
        store
            .listComments({ ctxId: "ctx-a" })
            .find((comment) => comment.id === "reply-target")?.status,
        "delivered",
    );
    assert.equal(
        store.readControlState("ctx-a").pendingReplyCommentId,
        "reply-target",
    );
    const stats = store.stats();
    assert.equal(stats.payloadBytes > 1_024, true);
    store.close();
});

test("MessageStore capacity evicts oldest terminal history before protected Comments", async () => {
    const root = await createTestTempDirectory("message-capacity");
    const maxBytes = 12_000;
    const store = new MessageStore({
        filePath: join(root, "message.sqlite3"),
        instanceName: "alpha",
        maxBytes,
        now: () => Date.parse("2026-09-11T00:00:00.000Z"),
        retentionDays: 365,
    });
    store.appendReport({
        callId: "report-old",
        createdAt: "2026-09-09T00:00:00.000Z",
        ctxId: "ctx-a",
        text: "a".repeat(8_000),
    });
    store.appendReport({
        callId: "report-new",
        createdAt: "2026-09-10T00:00:00.000Z",
        ctxId: "ctx-a",
        text: "b".repeat(8_000),
    });
    assert.deepEqual(
        store.list().map((entry) => entry.id),
        ["report-new"],
    );

    store.insertComment({
        createdAt: "2026-09-11T00:00:00.000Z",
        ctxId: "ctx-a",
        id: "protected-comment",
        instance: "alpha",
        status: "sent",
        text: "c".repeat(20_000),
    });
    assert.deepEqual(
        store.list().map((entry) => entry.id),
        ["protected-comment"],
    );
    const stats = store.stats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.protectedComments, 1);
    assert.equal(stats.maxBytes, maxBytes);
    assert.equal(stats.payloadBytes > maxBytes, true);
    store.close();
});

test("MessageService fences new work after retirement", async () => {
    const root = await createTestTempDirectory("message-retirement");
    const store = new MessageStore({
        filePath: join(root, "message.sqlite3"),
        instanceName: "alpha",
    });
    const service = new MessageService({ instanceName: "alpha", store });
    await service.recordReport({
        callId: "call-before",
        ctxId: "ctx-a",
        text: "Before retirement",
    });

    await service.retire();
    await assert.rejects(
        service.recordReport({
            callId: "call-late",
            ctxId: "ctx-a",
            text: "Must not be recorded",
        }),
        /not found or is disabled/u,
    );
    await assert.rejects(service.list(), /not found or is disabled/u);
    service.close();

    const reopened = new MessageStore({
        filePath: join(root, "message.sqlite3"),
        instanceName: "alpha",
    });
    assert.deepEqual(
        reopened.list().map((entry) => entry.text),
        ["Before retirement"],
    );
    reopened.close();
});

function createFutureDatabase(filePath: string, version: number): void {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
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

function createLegacyMessageDatabaseV1(filePath: string): void {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        database.exec(`
            CREATE TABLE conversation_entries (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                id TEXT NOT NULL,
                ctx_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                text TEXT NOT NULL,
                status TEXT,
                call_id TEXT,
                delivered_at TEXT,
                failed_at TEXT,
                error TEXT,
                UNIQUE(kind, id)
            ) STRICT;
            CREATE TABLE conversation_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
            INSERT INTO conversation_entries(
                kind, id, ctx_id, created_at, text, status, delivered_at
            ) VALUES (
                'comment', 'legacy-comment', 'ctx-legacy',
                '2026-09-10T10:00:00.000Z', 'Legacy message', 'delivered',
                '2026-09-10T10:00:01.000Z'
            );
            PRAGMA user_version = 1;
        `);
    } finally {
        database.close();
    }
}

function readFutureDatabase(filePath: string): {
    sentinel: string;
    tables: string[];
    userVersion: number;
} {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        const tables = (
            database
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
                )
                .all() as Array<{ name: string }>
        ).map((row) => row.name);
        const sentinel = (
            database.prepare("SELECT value FROM future_sentinel").get() as {
                value: string;
            }
        ).value;
        return {
            sentinel,
            tables,
            userVersion: readUserVersionFromDatabase(database),
        };
    } finally {
        database.close();
    }
}

function readUserVersion(filePath: string): number {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        return readUserVersionFromDatabase(database);
    } finally {
        database.close();
    }
}

function readUserVersionFromDatabase(
    database: import("node:sqlite").DatabaseSync,
): number {
    return Number(
        Object.values(
            database.prepare("PRAGMA user_version").get() as Record<
                string,
                number
            >,
        )[0] ?? 0,
    );
}
