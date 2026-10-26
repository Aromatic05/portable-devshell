import assert from "node:assert/strict";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import test from "node:test";

import { asInstanceName, ToolCallViewModel, type ToolCallRecord, type ToolTransport } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { AuditDatabase } from "../../src/audit/database/index.ts";
import { ToolCallHistory } from "../../src/toolcall/execution/record/History.ts";

test("Audit SQL reports an oversized first ToolCall rather than falsely returning an empty Context", async (t) => {
    const root = await createTestTempDirectory("toolcall-byte-budget");
    const database = new AuditDatabase(join(root, "audit.sqlite3"), {
        maxBytes: 16 * 1024 * 1024, retentionDays: 30,
    });
    t.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
    const store = database.toolCallStore({
        timestamp: (record) => record.completedAt ?? record.startedAt,
    });
    const at = new Date().toISOString();
    const base: ToolCallRecord = {
        callId: "small", ctxId: "ctx-a", inputSummary: "{}", instance: asInstanceName("test"),
        source: "mcp", startedAt: at, completedAt: at, status: "completed", toolName: "bash_run",
    };
    await store.append(base);
    await store.append({ ...base, callId: "large", output: { text: "X".repeat(4_096) } });

    assert.equal((await store.readQuery({ ctxId: "ctx-a" })).length, 2);
    assert.throws(() => store.readQuery({ ctxId: "ctx-a", limit: 50, maxBytes: 1_024 }), /exceeds maxBytes/u);
    assert.deepEqual((await store.readQuery({
        ctxId: "ctx-a", limit: 50, maxBytes: 1_024,
        includeInput: false, includeOutput: false,
    })).map((call) => call.callId), ["small", "large"]);
});

test("active ToolCalls cannot silently disappear when their metadata exceeds the byte budget", async (t) => {
    const root = await createTestTempDirectory("toolcall-active-budget");
    const database = new AuditDatabase(join(root, "audit.sqlite3"), {
        maxBytes: 16 * 1024 * 1024, retentionDays: 30,
    });
    t.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
    const history = new ToolCallHistory(asInstanceName("test"), database.toolCallStore({
        timestamp: (record) => record.completedAt ?? record.startedAt,
    }));
    await history.started("large-active", "bash_run", "X".repeat(4_096), {
        ctxId: "ctx-a", source: "mcp", workspace: "/repo",
    }, new Date().toISOString());
    await assert.rejects(history.read({
        ctxId: "ctx-a", status: "running", limit: 50,
        includeInput: false, includeOutput: false, maxBytes: 1_024,
    }), /exceeds maxBytes/u);
});

test("oversized metadata in a Context page surfaces a failure, never a false exhausted cursor", async (t) => {
    const root = await createTestTempDirectory("toolcall-context-budget");
    const database = new AuditDatabase(join(root, "audit.sqlite3"), {
        maxBytes: 16 * 1024 * 1024, retentionDays: 30,
    });
    t.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
    const store = database.toolCallStore({
        timestamp: (record) => record.completedAt ?? record.startedAt,
    });
    const at = new Date().toISOString();
    const base: ToolCallRecord = {
        callId: "old", ctxId: "ctx-a", inputSummary: "{}", instance: asInstanceName("test"),
        source: "mcp", startedAt: at, completedAt: at, status: "failed", toolName: "bash_run",
    };
    await store.append(base);
    await store.append({ ...base, callId: "latest-large-error", error: "E".repeat(600 * 1024) });
    const transport = { listCalls: async (query: Parameters<ToolTransport["listCalls"]>[0]) =>
        database.readToolCallRecords(query ?? {}) } as unknown as ToolTransport;
    const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
    t.after(() => model.close());
    await model.loadContext("test", "ctx-a");
    assert.match(model.state.context?.failure?.message ?? "", /exceeds maxBytes/u);
    assert.notEqual(model.state.context?.historyExhausted, true);
    assert.equal(model.state.context?.loading, false);
});

test("Core active ToolCall cursor finds an older Agent after 65 newer UI calls", async (t) => {
    const root = await createTestTempDirectory("toolcall-running-page");
    const database = new AuditDatabase(join(root, "audit.sqlite3"), {
        maxBytes: 16 * 1024 * 1024, retentionDays: 30,
    });
    t.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
    const history = new ToolCallHistory(asInstanceName("test"), database.toolCallStore({
        timestamp: (record) => record.completedAt ?? record.startedAt,
    }));
    const startedAt = new Date().toISOString();
    await history.started("actual-agent", "bash_run", "{}", {
        ctxId: "ctx-a", source: "mcp", workspace: "/repo",
    }, startedAt);
    for (let i = 0; i < 65; i++) {
        await history.started(`ui-${i}`, "mcpapp_open", "{}", {
            ctxId: "ctx-a", source: "mcp", workspace: "/repo",
        }, startedAt);
    }
    const query = { ctxId: "ctx-a", status: "running" as const,
        includeInput: false, includeOutput: false, limit: 64 };
    const first = await history.read(query);
    assert.equal(first.length, 64);
    assert.ok(first.every((record) => record.toolName === "mcpapp_open"));
    const older = await history.read({ ...query, before: first[0]!.callId });
    assert.ok(older.some((record) => record.callId === "actual-agent"));
    assert.equal(new Set([...first, ...older].map((record) => record.callId)).size, 66);
});

test("byte budget is finalized after merging active and persisted candidates", async (t) => {
    const root = await createTestTempDirectory("toolcall-merged-budget");
    const database = new AuditDatabase(join(root, "audit.sqlite3"), {
        maxBytes: 16 * 1024 * 1024, retentionDays: 30,
    });
    t.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
    const store = database.toolCallStore({ timestamp: (record) => record.completedAt ?? record.startedAt });
    const history = new ToolCallHistory(asInstanceName("test"), store);
    const at = new Date().toISOString();
    await store.append({ callId: "persisted-large", ctxId: "ctx-a", instance: asInstanceName("test"),
        inputSummary: "X".repeat(4096), source: "mcp", startedAt: at, completedAt: at,
        status: "completed", toolName: "bash_run" });
    await history.started("active-small", "bash_run", "{}", { ctxId: "ctx-a", source: "mcp" }, at);
    const query = { ctxId: "ctx-a", maxBytes: 1024, includeInput: false, includeOutput: false };
    assert.deepEqual((await history.read({ ...query, limit: 1 })).map((record) => record.callId), ["active-small"]);
    assert.deepEqual((await history.read({ ...query, limit: 2 })).map((record) => record.callId), ["active-small"]);
    await history.started("newest", "bash_run", "{}", { ctxId: "ctx-a", source: "mcp" }, at);
    assert.deepEqual((await history.read({ ...query, before: "newest", limit: 2 })).map((record) => record.callId), ["active-small"]);
    await assert.rejects(history.read({ ...query, before: "active-small", limit: 2 }), /exceeds maxBytes/u);
    await history.completed("active-small", at);
    assert.deepEqual((await history.read({ ...query, after: "persisted-large", limit: 1 })).map((record) => record.callId), ["active-small"]);
});

for (const cursor of ["before", "after"] as const) {
    test(`ToolCall ${cursor} rejects missing and wrong-Context cursors`, async (t) => {
        const root = await createTestTempDirectory("toolcall-invalid-cursor");
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 16 * 1024 * 1024, retentionDays: 30,
        });
        t.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
        const history = new ToolCallHistory(asInstanceName("test"), database.toolCallStore({
            timestamp: (record) => record.completedAt ?? record.startedAt,
        }));
        await assert.rejects(history.read({ [cursor]: "missing", ctxId: "ctx-a", limit: 64 }), /cursor is unavailable/u);
        await history.started("other", "bash_run", "{}", { ctxId: "ctx-b", source: "mcp" }, new Date().toISOString());
        await assert.rejects(history.read({ [cursor]: "other", ctxId: "ctx-a", limit: 64 }), /cursor is unavailable/u);
        await history.completed("other", new Date().toISOString());
        await assert.rejects(history.read({ [cursor]: "other", ctxId: "ctx-a", limit: 64 }), /cursor is unavailable/u);
        assert.deepEqual(await history.read({ [cursor]: "other", ctxId: "ctx-b", limit: 64 }), []);
    });
}
