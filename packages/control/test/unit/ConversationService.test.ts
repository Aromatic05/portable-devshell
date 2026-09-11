import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName, type ContextMessageRecord, type ToolCallRecord } from "@portable-devshell/shared";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import {
    CONVERSATION_DATABASE_SCHEMA_VERSION,
    ConversationStore,
} from "../../src/instance/conversation/ConversationStore.ts";
import { ConversationService } from "../../src/instance/conversation/ConversationService.ts";

test("ConversationStore migrates legacy Comments to v1 SQLite and preserves the source as a backup", async () => {
    const root = await createTestTempDirectory("conversation-comment-migration");
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
    assert.equal(readUserVersion(databaseFile), CONVERSATION_DATABASE_SCHEMA_VERSION);
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

test("ConversationStore rejects a newer schema without modifying it", async () => {
    const root = await createTestTempDirectory("conversation-future-schema");
    const databaseFile = join(root, "conversation.sqlite3");
    createFutureDatabase(databaseFile, CONVERSATION_DATABASE_SCHEMA_VERSION + 1);
    const before = readFutureDatabase(databaseFile);
    const store = new ConversationStore({ filePath: databaseFile, instanceName: "alpha" });

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
        legacyReports: async () => {
            migrations += 1;
            return [historical];
        },
        store,
    });

    assert.deepEqual(await service.list(), [{
        callId: "call-old",
        createdAt: "2026-09-10T10:02:00.000Z",
        ctxId: "ctx-a",
        id: "call-old",
        kind: "report",
        text: "Historical report",
    }]);
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
    assert.deepEqual((await service.list()).map((entry) => [entry.id, entry.text]), [
        ["call-old", "Historical report"],
        ["call-new", "New report"],
    ]);
    assert.equal(migrations, 1);
    service.close();
});

function createFutureDatabase(filePath: string, version: number): void {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
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

function readFutureDatabase(filePath: string): { sentinel: string; tables: string[]; userVersion: number } {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        const tables = (database.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        ).all() as Array<{ name: string }>).map((row) => row.name);
        const sentinel = (database.prepare("SELECT value FROM future_sentinel").get() as { value: string }).value;
        return { sentinel, tables, userVersion: readUserVersionFromDatabase(database) };
    } finally {
        database.close();
    }
}

function readUserVersion(filePath: string): number {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        return readUserVersionFromDatabase(database);
    } finally {
        database.close();
    }
}

function readUserVersionFromDatabase(database: import("node:sqlite").DatabaseSync): number {
    return Number(Object.values(database.prepare("PRAGMA user_version").get() as Record<string, number>)[0] ?? 0);
}
