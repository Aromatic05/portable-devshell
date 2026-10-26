import assert from "node:assert/strict";
import test from "node:test";

import { ToolCallViewModel } from "../../src/execution/toolcall/ViewModel.ts";
import type { ToolCallQuery, ToolCallRecord } from "../../src/execution/toolcall/Model.ts";
import type { ToolTransport } from "../../src/execution/toolcall/Transport.ts";
import { asInstanceName } from "../../src/types/Instance.ts";

test("Context history filters on the server before paging and remains independent from the instance preview", async (t) => {
    const instance = asInstanceName("alpha");
    const records: ToolCallRecord[] = [];
    for (let round = 0; round < 230; round++) {
        for (let context = 0; context < 30; context++) {
            const id = String(context).padStart(3, "0");
            records.push({
                callId: `call-${round}-${id}`,
                ctxId: `ctx-${id}`,
                instance,
                inputSummary: "{}",
                source: "mcp",
                startedAt: new Date(1_790_000_000_000 + records.length * 1000).toISOString(),
                status: "completed",
                toolName: "bash_run",
                workspace: `/repo/${id}`,
            });
        }
    }
    const queries: ToolCallQuery[] = [];
    const transport = {
        listCalls: async (query: ToolCallQuery = {}) => {
            queries.push(query);
            const end = query.before === undefined
                ? records.length : records.findIndex((item) => item.callId === query.before);
            return records.slice(0, end)
                .filter((item) => query.ctxId === undefined || item.ctxId === query.ctxId)
                .slice(-(query.limit ?? records.length));
        },
        subscribe: async () => ({
            close() {},
            next: async () => await new Promise<never>(() => {}),
        }),
    } as unknown as ToolTransport;
    const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
    t.after(() => model.close());

    await model.load("alpha");
    assert.equal(model.state.instances.alpha?.calls.length, 200);
    assert.equal(model.state.instances.alpha?.calls.filter((call) => call.ctxId === "ctx-007").length, 6);
    await model.loadContext("alpha", "ctx-007");
    assert.equal(queries.at(-1)?.ctxId, "ctx-007");
    assert.equal(model.state.context?.calls.length, 200);
    assert.equal(model.state.context?.historyBefore, "call-30-007");
    assert.equal(await model.loadOlderContext("alpha", "ctx-007"), 30);
    assert.equal(queries.at(-1)?.before, "call-30-007");
    assert.equal(queries.at(-1)?.ctxId, "ctx-007");
    assert.equal(model.state.context?.calls.length, 230);
    assert.equal(new Set(model.state.context?.calls.map((call) => call.callId)).size, 230);

    records.push({ ...records[7]!, callId: "call-live-007", startedAt: new Date(1_790_100_000_000).toISOString() });
    await model.refresh("alpha");
    for (let retry = 0; retry < 10 && model.state.context?.calls.length !== 231; retry++)
        await new Promise((resolve) => setImmediate(resolve));
    assert.equal(model.state.context?.calls.length, 231);
    assert.equal(model.state.instances.alpha?.calls.length, 200);

    await model.loadContext("alpha", "ctx-008");
    assert.equal(model.state.context?.ctxId, "ctx-008");
    assert.equal(model.state.context?.calls.length, 200);
    assert.equal(await model.loadOlderContext("alpha", "ctx-008"), 30);
    assert.equal(model.state.context?.calls.length, 230);
    assert.equal(model.state.instances.alpha?.calls.length, 200);
});

test("Context history ignores stale responses after switching Contexts", async (t) => {
    let resolveOld!: (records: ToolCallRecord[]) => void;
    const oldResponse = new Promise<ToolCallRecord[]>((resolve) => { resolveOld = resolve; });
    const record = (ctxId: string): ToolCallRecord => ({
        callId: `call-${ctxId}`, ctxId, instance: asInstanceName("alpha"),
        inputSummary: "{}", source: "mcp", startedAt: "2026-10-26T00:00:00Z",
        status: "completed", toolName: "bash_run",
    });
    const transport = {
        listCalls: async (query: ToolCallQuery = {}) =>
            query.ctxId === "ctx-old" ? await oldResponse : [record(query.ctxId ?? "other")],
        subscribe: async () => ({ close() {}, next: async () => await new Promise<never>(() => {}) }),
    } as unknown as ToolTransport;
    const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
    t.after(() => model.close());

    const oldRead = model.loadContext("alpha", "ctx-old");
    await model.loadContext("alpha", "ctx-new");
    resolveOld([record("ctx-old")]);
    await oldRead;
    assert.equal(model.state.context?.ctxId, "ctx-new");
    assert.deepEqual(model.state.context?.calls.map((call) => call.callId), ["call-ctx-new"]);
    model.clearContext("alpha", "ctx-old");
    assert.equal(model.state.context?.ctxId, "ctx-new");
    model.clearContext("alpha", "ctx-new");
    assert.equal(model.state.context, undefined);
    await model.refresh("alpha");
    assert.equal(model.state.context, undefined);
});

test("A Context's older page cannot append to a different Context after navigation", async (t) => {
    const record = (ctxId: string, callId: string): ToolCallRecord => ({
        callId, ctxId, instance: asInstanceName("alpha"), inputSummary: "{}",
        source: "mcp", startedAt: "2026-10-26T00:00:00Z", status: "completed", toolName: "bash_run",
    });
    let resolveOlder!: (records: ToolCallRecord[]) => void;
    const olderResponse = new Promise<ToolCallRecord[]>((resolve) => { resolveOlder = resolve; });
    const transport = {
        listCalls: async (query: ToolCallQuery = {}) =>
            query.ctxId === "ctx-first" && query.before !== undefined
                ? await olderResponse : [record(query.ctxId ?? "other", `head-${query.ctxId ?? "other"}`)],
        subscribe: async () => ({ close() {}, next: async () => await new Promise<never>(() => {}) }),
    } as unknown as ToolTransport;
    const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
    t.after(() => model.close());

    await model.loadContext("alpha", "ctx-first");
    const older = model.loadOlderContext("alpha", "ctx-first");
    await model.loadContext("alpha", "ctx-second");
    resolveOlder([record("ctx-first", "older-first")]);
    assert.equal(await older, 0);
    assert.equal(model.state.context?.ctxId, "ctx-second");
    assert.deepEqual(model.state.context?.calls.map((call) => call.callId), ["head-ctx-second"]);
});

test("Switching Contexts directly releases the old pending page even if the same Context is reopened", async (t) => {
    let resolveOld!: (records: ToolCallRecord[]) => void;
    const oldResponse = new Promise<ToolCallRecord[]>((resolve) => { resolveOld = resolve; });
    const record = (ctxId: string, callId: string): ToolCallRecord => ({
        callId, ctxId, instance: asInstanceName("alpha"), inputSummary: "{}",
        source: "mcp", startedAt: "2026-10-26T00:00:00Z", status: "completed", toolName: "bash_run",
    });
    let pages = 0;
    const transport = {
        listCalls: async (query: ToolCallQuery = {}) => {
            if (query.before === undefined) return [record(query.ctxId!, `head-${query.ctxId}`)];
            pages += 1;
            return pages === 1 ? await oldResponse : [record(query.ctxId!, "fresh-page")];
        },
        subscribe: async () => ({ close() {}, next: async () => await new Promise<never>(() => {}) }),
    } as unknown as ToolTransport;
    const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
    t.after(() => model.close());

    await model.loadContext("alpha", "ctx-first");
    const oldPage = model.loadOlderContext("alpha", "ctx-first");
    await model.loadContext("alpha", "ctx-second");
    await model.loadContext("alpha", "ctx-first");
    const newPage = model.loadOlderContext("alpha", "ctx-first");
    resolveOld([record("ctx-first", "stale-page")]);
    assert.equal(await oldPage, 0);
    assert.equal(await newPage, 1);
    assert.deepEqual(model.state.context?.calls.map((entry) => entry.callId).sort(), ["fresh-page", "head-ctx-first"]);
});

test("A stale older page cannot append after leaving and reopening the same Context", async (t) => {
    const record = (callId: string): ToolCallRecord => ({
        callId, ctxId: "ctx-repeat", instance: asInstanceName("alpha"),
        inputSummary: "{}", source: "mcp", startedAt: "2026-10-26T00:00:00Z",
        status: "completed", toolName: "bash_run",
    });
    let resolveOld!: (records: ToolCallRecord[]) => void;
    const oldResponse = new Promise<ToolCallRecord[]>((resolve) => { resolveOld = resolve; });
    let olderReads = 0;
    const transport = {
        listCalls: async (query: ToolCallQuery = {}) => {
            if (query.before === undefined) return [record("head")];
            olderReads += 1;
            return olderReads === 1 ? await oldResponse : [record("current-older")];
        },
        subscribe: async () => ({ close() {}, next: async () => await new Promise<never>(() => {}) }),
    } as unknown as ToolTransport;
    const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
    t.after(() => model.close());

    await model.loadContext("alpha", "ctx-repeat");
    const old = model.loadOlderContext("alpha", "ctx-repeat");
    model.clearContext("alpha", "ctx-repeat");
    await model.loadContext("alpha", "ctx-repeat");
    resolveOld([record("stale-older")]);
    assert.equal(await old, 0);
    assert.deepEqual(model.state.context?.calls.map((item) => item.callId), ["head"]);
    assert.equal(await model.loadOlderContext("alpha", "ctx-repeat"), 1);
    assert.deepEqual(model.state.context?.calls.map((item) => item.callId).sort(), ["current-older", "head"]);
});

test("ToolCall history reads older audit slices and retains them across live refresh", async (t) => {
    const records: ToolCallRecord[] = Array.from({ length: 260 }, (_, index) => ({
        callId: `call-${String(index).padStart(3, "0")}`,
        instance: asInstanceName("alpha"),
        inputSummary: "audit entry",
        source: "mcp",
        startedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
        status: "completed",
        toolName: "bash_run",
    }));
    // The UI sorts by startedAt, but the audit cursor is the stored record ID.
    records[60] = { ...records[60]!, startedAt: "2099-01-01T00:00:00Z" };
    const queries: ToolCallQuery[] = [];
    const transport = {
        listCalls: async (query: ToolCallQuery = {}) => {
            queries.push(query);
            const end = query.before === undefined
                ? records.length : records.findIndex((item) => item.callId === query.before);
            return records.slice(0, end)
                .filter((item) => query.toolName === undefined || item.toolName === query.toolName)
                .slice(-(query.limit ?? records.length));
        },
        subscribe: async () => ({
            close() {},
            next: async () => await new Promise<never>(() => {}),
        }),
    } as unknown as ToolTransport;
    const model = new ToolCallViewModel({
        cursor: async () => 0,
        transport: () => transport,
    });
    t.after(() => model.close());

    await model.load("alpha");
    assert.equal(model.state.instances.alpha?.calls.length, 200);
    assert.equal(model.state.instances.alpha?.historyBefore, "call-060");
    assert.equal(await model.loadOlder("alpha"), 60);
    assert.equal(queries.at(-1)?.before, "call-060");
    assert.equal(model.state.instances.alpha?.calls.length, 260);
    assert.equal(model.state.instances.alpha?.historyBefore, "call-000");
    assert.equal(await model.loadOlder("alpha"), 0);
    assert.equal(model.state.instances.alpha?.historyExhausted, true);

    records.push({
        ...records[259]!,
        callId: "call-260",
        startedAt: new Date(1_700_000_300_000).toISOString(),
    });
    await model.refresh("alpha");
    assert.equal(model.state.instances.alpha?.calls.length, 261);
    assert.equal(model.state.instances.alpha?.calls.filter((call) => call.callId === "call-000").length, 1);
    assert.equal(model.state.instances.alpha?.historyExhausted, true);

    await model.load("alpha", { toolName: "file_read" });
    assert.deepEqual(model.state.instances.alpha?.calls, []);
    assert.equal(model.state.instances.alpha?.historyExhausted, true);
    assert.equal(model.state.instances.alpha?.historyLoaded, false);
});

for (const scope of ["instance", "context"] as const) {
    test(`paged ${scope} refresh bridges more than 200 new calls and preserves the older cursor`, async (t) => {
        const record = (index: number): ToolCallRecord => ({
            callId: `call-${index}`, ctxId: "ctx-a", instance: asInstanceName("alpha"),
            inputSummary: "{}", source: "mcp", status: "completed", toolName: "bash_run",
            startedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
        });
        const records = Array.from({ length: 450 }, (_, i) => record(i));
        const transport = {
            listCalls: async (query: ToolCallQuery = {}) => {
                const end = query.before === undefined ? records.length : records.findIndex((call) => call.callId === query.before);
                return records.slice(0, end).slice(-(query.limit ?? 200));
            },
            subscribe: async () => ({ close() {}, next: async () => await new Promise<never>(() => {}) }),
        } as unknown as ToolTransport;
        const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
        t.after(() => model.close());
        const load = scope === "instance" ? () => model.load("alpha") : () => model.loadContext("alpha", "ctx-a");
        const older = scope === "instance" ? () => model.loadOlder("alpha") : () => model.loadOlderContext("alpha", "ctx-a");
        const state = () => scope === "instance" ? model.state.instances.alpha : model.state.context;
        await load();
        assert.equal(await older(), 200);
        assert.equal(state()?.historyBefore, "call-50");
        records.push(...Array.from({ length: 550 }, (_, i) => record(i + 450)));
        await load();
        assert.deepEqual(state()?.calls.map((call) => call.callId), records.slice(50).reverse().map((call) => call.callId));
        assert.equal(state()?.historyBefore, "call-50");
        assert.equal(await older(), 50);
        assert.equal(await older(), 0);
        assert.equal(state()?.historyExhausted, true);
        assert.deepEqual(state()?.calls.map((call) => call.callId), records.slice().reverse().map((call) => call.callId));
        records.push(...Array.from({ length: 250 }, (_, i) => record(i + 1000)));
        await load();
        assert.equal(state()?.historyExhausted, true);
        assert.equal(state()?.historyBefore, "call-0");
        assert.deepEqual(state()?.calls.map((call) => call.callId), records.slice().reverse().map((call) => call.callId));
    });
}

test("an unavailable Context cursor surfaces failure and preserves history rather than marking exhausted", async (t) => {
    const call: ToolCallRecord = {
        callId: "retained-head", ctxId: "ctx-a", instance: asInstanceName("alpha"), inputSummary: "{}",
        source: "mcp", startedAt: "2026-10-27T00:00:00Z", status: "completed", toolName: "bash_run",
    };
    const failure = new Error("ToolCall history cursor is unavailable in the requested Context.");
    const transport = { listCalls: async (query: ToolCallQuery = {}) => {
        if (query.before !== undefined) throw failure;
        return [call];
    } } as unknown as ToolTransport;
    const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
    t.after(() => model.close());
    await model.loadContext("alpha", "ctx-a");
    await assert.rejects(model.loadOlderContext("alpha", "ctx-a"), failure);
    assert.equal(model.state.context?.failure?.message, failure.message);
    assert.equal(model.state.context?.historyExhausted, false);
    assert.equal(model.state.context?.historyBefore, "retained-head");
    assert.deepEqual(model.state.context?.calls.map((record) => record.callId), ["retained-head"]);
});
