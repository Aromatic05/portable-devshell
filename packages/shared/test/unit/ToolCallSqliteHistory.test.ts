import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { AuditDatabase } from "../../../core/src/audit/database/index.ts";
import { ToolCallHistory } from "../../../core/src/toolcall/execution/record/History.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { ToolCallViewModel } from "../../src/execution/toolcall/ViewModel.ts";
import type { ToolCallQuery, ToolCallRecord } from "../../src/execution/toolcall/Model.ts";
import type { ToolTransport } from "../../src/execution/toolcall/Transport.ts";
import { asInstanceName } from "../../src/types/Instance.ts";

for (const scope of ["instance", "context"] as const) {
    for (const anchor of ["running", "queued", "completed-before-refresh", "byte-limited"] as const) {
        test(`SQLite ${scope} refresh bridges a ${anchor} old active anchor without losing 351 calls`, async (t) => {
            const root = await createTestTempDirectory("toolcall-sqlite-bridge");
            const database = new AuditDatabase(join(root, "audit.sqlite3"), {
                maxBytes: 32 * 1024 * 1024, retentionDays: 30,
            });
            const store = database.toolCallStore({ timestamp: (record) => record.completedAt ?? record.startedAt });
            const instance = asInstanceName("alpha");
            const history = new ToolCallHistory(instance, store);
            let reads = 0;
            const transport = {
                listCalls: async (query: ToolCallQuery = {}) => {
                    reads += 1;
                    const page = await history.read(query);
                    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= (query?.maxBytes ?? Infinity));
                    assert.ok(page.length <= (query?.limit ?? Infinity));
                    assert.ok(page.every((record) => record.input === undefined && record.output === undefined));
                    return page;
                },
                subscribe: async () => ({ close() {}, next: async () => await new Promise<never>(() => {}) }),
            } as unknown as ToolTransport;
            const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
            t.after(async () => { model.close(); await database.close(); await rm(root, { recursive: true, force: true }); });
            const at = new Date().toISOString();
            const record = (i: number): ToolCallRecord => ({
                callId: `call-${i}`, ctxId: "ctx-a", instance, inputSummary: "{}", source: "mcp",
                startedAt: new Date(Date.parse(at) - (1001 - i) * 1000).toISOString(), completedAt: at,
                status: "completed", toolName: "bash_run", input: { hidden: true }, output: { hidden: true },
            });
            const load = scope === "instance" ? () => model.load("alpha") : () => model.loadContext("alpha", "ctx-a");
            const older = scope === "instance" ? () => model.loadOlder("alpha") : () => model.loadOlderContext("alpha", "ctx-a");
            const state = () => scope === "instance" ? model.state.instances.alpha! : model.state.context!;
            for (let i = 0; i < 450; i++) await store.append(record(i));
            await history.started("long-running", "bash_run", "{}", { ctxId: "ctx-a", source: "mcp" },
                new Date(Date.parse(at) - 2000 * 1000).toISOString(), anchor === "queued" ? "queued" : "running");
            await load();
            assert.equal(await older(), 200);
            assert.equal(state().calls.length, 400);
            assert.equal(state().historyBefore, "call-51");
            for (let i = 450; i < 1000; i++) await store.append({
                ...record(i), inputSummary: anchor === "byte-limited" ? "X".repeat(8192) : "{}",
            });
            if (anchor === "completed-before-refresh") await history.completed("long-running", at);
            reads = 0;
            await load();
            assert.equal(state().failure, undefined);
            assert.equal(state().historyBefore, "call-51");
            assert.deepEqual(new Set(state().calls.map((call) => call.callId)),
                new Set(["long-running", ...Array.from({ length: 949 }, (_, i) => `call-${i + 51}`)]));
            assert.ok(reads >= 3);
            assert.deepEqual(state().calls.map((call) => call.callId),
                [...state().calls].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.callId.localeCompare(b.callId)).map((call) => call.callId));
            assert.equal(await older(), 51);
            assert.equal(await older(), 0);
            assert.equal(state().historyExhausted, true);
            if (anchor !== "completed-before-refresh") await history.completed("long-running", at);
            await load();
            assert.equal(state().calls.length, 1001);
            assert.equal(state().calls.find((call) => call.callId === "long-running")?.status, "completed");
            assert.deepEqual(new Set(state().calls.map((call) => call.callId)),
                new Set((await history.read({ ctxId: "ctx-a" })).map((call) => call.callId)));
            assert.equal(state().historyExhausted, true);
        });
    }

    test(`SQLite ${scope} refresh reaches the authoritative end when only active history was retained`, async (t) => {
        const root = await createTestTempDirectory("toolcall-sqlite-active-only");
        const database = new AuditDatabase(join(root, "audit.sqlite3"), { maxBytes: 16 * 1024 * 1024, retentionDays: 30 });
        const history = new ToolCallHistory(asInstanceName("alpha"), database.toolCallStore({ timestamp: (record) => record.completedAt ?? record.startedAt }));
        let reads = 0;
        const transport = {
            listCalls: async (query: ToolCallQuery = {}) => { reads += 1; return await history.read(query); },
            subscribe: async () => ({ close() {}, next: async () => await new Promise<never>(() => {}) }),
        } as unknown as ToolTransport;
        const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
        t.after(async () => { model.close(); await database.close(); await rm(root, { recursive: true, force: true }); });
        const at = new Date().toISOString();
        await history.started("anchor", "bash_run", "{}", { ctxId: "ctx-a", source: "mcp" }, at);
        const load = scope === "instance" ? () => model.load("alpha") : () => model.loadContext("alpha", "ctx-a");
        const older = scope === "instance" ? () => model.loadOlder("alpha") : () => model.loadOlderContext("alpha", "ctx-a");
        const state = () => scope === "instance" ? model.state.instances.alpha! : model.state.context!;
        await load();
        assert.equal(await older(), 0);
        assert.equal(state().historyExhausted, true);
        for (let i = 0; i < 550; i++) {
            await history.started(`call-${i}`, "bash_run", "{}", { ctxId: "ctx-a", source: "mcp" }, at);
            await history.completed(`call-${i}`, at);
        }
        reads = 0;
        await load();
        assert.equal(state().failure, undefined);
        assert.equal(state().calls.length, 551);
        assert.equal(reads, 4);
        assert.equal(state().historyExhausted, true);
        assert.equal(await older(), 0);
        await history.completed("anchor", at);
        await load();
        assert.equal(state().calls.find((call) => call.callId === "anchor")?.status, "completed");
        assert.equal(state().calls.length, 551);
    });
}
