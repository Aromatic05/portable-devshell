import assert from "node:assert/strict";
import test from "node:test";

import { ToolCallViewModel } from "../../src/execution/toolcall/ViewModel.ts";
import type { ToolCallQuery, ToolCallRecord } from "../../src/execution/toolcall/Model.ts";
import type { ToolTransport } from "../../src/execution/toolcall/Transport.ts";
import { asInstanceName } from "../../src/types/Instance.ts";

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
