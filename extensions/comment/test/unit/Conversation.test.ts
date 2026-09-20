import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import {
    asInstanceName,
    type ContextMessageRecord,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { ConversationStore } from "../../src/conversation/store/ConversationStore.ts";
import {
    CONVERSATION_DATABASE_SCHEMA_VERSION,
    defaultConversationStorageLimits,
} from "../../src/conversation/store/Schema.ts";
import { ConversationService } from "../../src/conversation/ConversationService.ts";

test("ConversationStore migrates legacy Comments to v1 SQLite and preserves the source as a backup", async () => {
    const root = await createTestTempDirectory(
        "conversation-comment-migration",
    );
    const legacyFile = join(root, "context-messages.json");
    const databaseFile = join(root, "conversation.sqlite3");
    const legacy: ContextMessageRecord = {
        callId: "call-comment",
        createdAt: "2026-09-10T10:00:00.000Z",
        ctxId: "ctx-a",
        deliveredAt: "2026-09-10T10:01:00.000Z",
        id: "message-a",
        instance: "alpha",
        status: "delivered",
        text: "Preserve this Comment",
    };
    const source = `${JSON.stringify({ messages: [legacy], version: 1 })}\n`;
    writeFileSync(legacyFile, source, { mode: 0o600 });

    const store = new ConversationStore({
        filePath: databaseFile,
        instanceName: "alpha",
        legacyContextMessagesFile: legacyFile,
    });
    assert.deepEqual(store.listComments(), [legacy]);
    assert.equal(
        readUserVersion(databaseFile),
        CONVERSATION_DATABASE_SCHEMA_VERSION,
    );
    assert.equal(existsSync(legacyFile), false);
    assert.equal(readFileSync(`${legacyFile}.migrated-v1.bak`, "utf8"), source);
    store.close();

    const reopened = new ConversationStore({
        filePath: databaseFile,
        instanceName: "alpha",
        legacyContextMessagesFile: legacyFile,
    });
    assert.deepEqual(reopened.listComments(), [legacy]);
    reopened.close();
});

test("ConversationStore backfills durable control state from pre-metadata history once", async () => {
    const root = await createTestTempDirectory("conversation-control-backfill");
    const databaseFile = join(root, "conversation.sqlite3");
    const store = new ConversationStore({
        filePath: databaseFile,
        instanceName: "alpha",
    });
    store.insertComment({
        createdAt: "2026-09-10T10:00:00.000Z",
        ctxId: "ctx-a",
        deliveredAt: "2026-09-10T10:00:01.000Z",
        id: "legacy-stop",
        instance: "alpha",
        status: "delivered",
        text: "#stop Preserve this fence",
    });
    store.close();
    mutateConversationDatabase(
        databaseFile,
        `
        DELETE FROM conversation_metadata
        WHERE key LIKE 'context-control:v1:%' OR key = 'migration:context-control-v2'
    `,
    );

    const backfilled = new ConversationStore({
        filePath: databaseFile,
        instanceName: "alpha",
    });
    assert.deepEqual(backfilled.readControlState("ctx-a"), {
        stoppedByCommentId: "legacy-stop",
    });
    backfilled.close();
    mutateConversationDatabase(
        databaseFile,
        "DELETE FROM conversation_entries WHERE ctx_id = 'ctx-a'",
    );
    const withoutHistory = new ConversationStore({
        filePath: databaseFile,
        instanceName: "alpha",
    });
    assert.deepEqual(withoutHistory.readControlState("ctx-a"), {
        stoppedByCommentId: "legacy-stop",
    });
    withoutHistory.close();
});

test("ConversationStore v2 control migration repairs legacy #push reply targets", async () => {
    const root = await createTestTempDirectory("conversation-control-v2-push");
    const databaseFile = join(root, "conversation.sqlite3");
    const store = new ConversationStore({
        filePath: databaseFile,
        instanceName: "alpha",
    });
    store.insertComment({
        createdAt: "2026-09-10T10:00:00.000Z",
        ctxId: "ctx-a",
        deliveredAt: "2026-09-10T10:00:01.000Z",
        id: "question-1",
        instance: "alpha",
        status: "delivered",
        text: "Explain the original failure",
    });
    store.insertComment({
        createdAt: "2026-09-10T10:00:02.000Z",
        ctxId: "ctx-a",
        deliveredAt: "2026-09-10T10:00:03.000Z",
        id: "push-1",
        instance: "alpha",
        status: "delivered",
        text: "#push",
    });
    store.close();
    mutateConversationDatabase(
        databaseFile,
        `
        DELETE FROM conversation_metadata
        WHERE key = 'migration:context-control-v2';
        INSERT INTO conversation_metadata(key, value)
        VALUES ('migration:context-control-v1', 'complete')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        INSERT INTO conversation_metadata(key, value)
        VALUES (
            'context-control:v1:ctx-a',
            '{"pendingPushCommentId":"push-1","pendingReplyCommentId":"push-1","pushToolCallsRemaining":0}'
        )
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `,
    );

    const migrated = new ConversationStore({
        filePath: databaseFile,
        instanceName: "alpha",
    });
    assert.deepEqual(migrated.readControlState("ctx-a"), {
        pendingPushCommentId: "push-1",
        pendingReplyCommentId: "question-1",
        pushToolCallsRemaining: 0,
    });
    migrated.close();
});

test("ConversationStore rejects a newer schema without modifying it", async () => {
    const root = await createTestTempDirectory("conversation-future-schema");
    const databaseFile = join(root, "conversation.sqlite3");
    createFutureDatabase(
        databaseFile,
        CONVERSATION_DATABASE_SCHEMA_VERSION + 1,
    );
    const before = readFutureDatabase(databaseFile);
    const store = new ConversationStore({
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

test("ConversationStore defaults to a 512 MiB fuse and 90 day retention", () => {
    assert.deepEqual(defaultConversationStorageLimits, {
        maxBytes: 512 * 1024 * 1024,
        retentionDays: 90,
    });
});

test("ConversationStore retention removes old terminal history but never old pending or sent Comments", async () => {
    const root = await createTestTempDirectory("conversation-retention");
    const store = new ConversationStore({
        filePath: join(root, "conversation.sqlite3"),
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

test("ConversationStore preserves a delivered Comment while control state still needs it as the reply target", async () => {
    const root = await createTestTempDirectory("conversation-reply-target-retention");
    const store = new ConversationStore({
        filePath: join(root, "conversation.sqlite3"),
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

    store.deliverComments(
        "ctx-a",
        "delivery-call",
        "2026-07-01T00:01:00.000Z",
    );

    assert.equal(store.comment("ctx-a", "reply-target")?.status, "delivered");
    assert.equal(
        store.readControlState("ctx-a").pendingReplyCommentId,
        "reply-target",
    );
    const stats = store.stats();
    assert.equal(stats.payloadBytes > 1_024, true);
    store.close();
});

test("ConversationStore capacity evicts oldest terminal history before protected Comments", async () => {
    const root = await createTestTempDirectory("conversation-capacity");
    const maxBytes = 12_000;
    const store = new ConversationStore({
        filePath: join(root, "conversation.sqlite3"),
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

test("ConversationService imports historical todo_report calls and records new reports idempotently", async () => {
    const root = await createTestTempDirectory("conversation-report-migration");
    const store = new ConversationStore({
        filePath: join(root, "conversation.sqlite3"),
        instanceName: "alpha",
    });
    let migrations = 0;
    const historical: ToolCallRecord = {
        callId: "call-old",
        completedAt: "2026-09-10T10:02:00.000Z",
        ctxId: "ctx-a",
        input: { message: "Historical report" },
        inputSummary: "Historical report",
        instance: asInstanceName("alpha"),
        source: "mcp",
        startedAt: "2026-09-10T10:01:00.000Z",
        status: "completed",
        toolName: "todo_report",
    };
    const service = new ConversationService({
        instanceName: "alpha",
        legacyReports: async () => {
            migrations += 1;
            return [historical];
        },
        store,
    });

    assert.deepEqual(await service.list(), [
        {
            callId: "call-old",
            createdAt: "2026-09-10T10:02:00.000Z",
            ctxId: "ctx-a",
            id: "call-old",
            kind: "report",
            text: "Historical report",
        },
    ]);
    await service.recordReport({
        callId: "call-new",
        createdAt: "2026-09-10T10:03:00.000Z",
        ctxId: "ctx-a",
        text: "New report",
    });
    await service.recordReport({
        callId: "call-new",
        createdAt: "2026-09-10T10:03:00.000Z",
        ctxId: "ctx-a",
        text: "New report",
    });
    assert.deepEqual(
        (await service.list()).map((entry) => [entry.id, entry.text]),
        [
            ["call-old", "Historical report"],
            ["call-new", "New report"],
        ],
    );
    assert.equal(migrations, 1);
    service.close();
});

test("ConversationService retirement fences new work and drains an in-flight legacy migration before close", async () => {
    const root = await createTestTempDirectory("conversation-retirement-drain");
    const store = new ConversationStore({
        filePath: join(root, "conversation.sqlite3"),
        instanceName: "alpha",
    });
    let releaseMigration!: () => void;
    const migrationGate = new Promise<void>((resolve) => {
        releaseMigration = resolve;
    });
    let markMigrationStarted!: () => void;
    const migrationStarted = new Promise<void>((resolve) => {
        markMigrationStarted = resolve;
    });
    const historical: ToolCallRecord = {
        callId: "call-old",
        completedAt: "2026-09-10T10:02:00.000Z",
        ctxId: "ctx-a",
        input: { message: "Historical report" },
        inputSummary: "Historical report",
        instance: asInstanceName("alpha"),
        source: "mcp",
        startedAt: "2026-09-10T10:01:00.000Z",
        status: "completed",
        toolName: "todo_report",
    };
    const service = new ConversationService({
        instanceName: "alpha",
        legacyReports: async () => {
            markMigrationStarted();
            await migrationGate;
            return [historical];
        },
        store,
    });

    const listing = service.list();
    await migrationStarted;
    let retirementFinished = false;
    const retirement = service.retire().then(() => {
        retirementFinished = true;
    });
    await Promise.resolve();
    assert.equal(retirementFinished, false);
    await assert.rejects(
        service.recordReport({
            callId: "call-late",
            ctxId: "ctx-a",
            text: "Must not be recorded",
        }),
        /not found or is disabled/u,
    );
    await assert.rejects(service.list(), /not found or is disabled/u);

    releaseMigration();
    assert.equal((await listing)[0]?.text, "Historical report");
    await retirement;
    assert.equal(retirementFinished, true);
    service.close();

    const reopened = new ConversationStore({
        filePath: join(root, "conversation.sqlite3"),
        instanceName: "alpha",
    });
    assert.deepEqual(
        reopened.list().map((entry) => entry.text),
        ["Historical report"],
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

function mutateConversationDatabase(filePath: string, sql: string): void {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        database.exec(sql);
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
