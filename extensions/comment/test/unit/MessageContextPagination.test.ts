import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { databaseConnection } from "../helpers/Database.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";

test("MessageStore filters by Context before LIMIT, keeps cursor ownership and reports oversized rows", async () => {
    const root = await createTestTempDirectory("message-context-sql-pagination");
    const filePath = join(root, "message.sqlite3");
    const store = new MessageStore({
        filePath,
        openDatabase: () => databaseConnection(filePath),
        instanceName: "alpha",
    });
    try {
        const now = Date.now();
        for (let index = 0; index < 30 * 25; index++) {
            await store.insertComment({
                createdAt: new Date(now + index).toISOString(),
                ctxId: `ctx-${index % 30}`,
                id: `message-${index}`,
                instance: "alpha",
                status: "sent",
                text: `Message ${index}`,
            });
        }
        const preview = await store.list({ limit: 400 });
        assert.equal(preview.length, 400);
        assert.ok(preview.filter((item) => item.ctxId === "ctx-7").length < 25);

        const latest = await store.list({ ctxId: "ctx-7", limit: 20 });
        assert.equal(latest.length, 20);
        assert.ok(latest.every((item) => item.ctxId === "ctx-7"));
        const older = await store.list({ ctxId: "ctx-7", before: latest[0]!.id, limit: 20 });
        assert.equal(older.length, 5);
        assert.equal(new Set([...latest, ...older].map((item) => item.id)).size, 25);
        await assert.rejects(() => store.list({ ctxId: "ctx-7", before: "message-8", limit: 20 }),
            /cursor is unavailable/u, "A cursor from another Context must not page this Context");
        await assert.rejects(() => store.list({ ctxId: "ctx-7", before: "unknown-id", limit: 20 }),
            /cursor is unavailable/u, "Unknown cursors must not silently restart at the newest page");
        await assert.rejects(() => store.list({ ctxId: "ctx-7", limit: 20, maxBytes: 100 }),
            /exceeds maxBytes/u);
        assert.equal((await store.list({ ctxId: "ctx-7", limit: 20 })).length, 20);
    } finally {
        await store.close();
    }
});
