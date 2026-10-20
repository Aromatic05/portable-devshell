import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAuditRuntime } from "../../../src/audit/index.ts";
import { round4Target } from "./Round4Harness.ts";

test("round4: adapted Unicode terminal output survives a fresh SQLite runtime with exact Context projection", async (t) => {
    const h = await round4Target(); t.after(() => h.close());
    const output = { text: "中文\u0000😀".repeat(20_000), nested: { completed: true } };
    h.runtime.hooks.registerExecute("local_effect", async () => ({ private: "unadapted" }));
    assert.deepEqual(await h.runtime.api.call("round4", "local_effect", { token: "owned-input" },
        { source: "mcp", ctxId: "durable-context", requestId: "durable-request", workspace: h.directory },
        undefined, async () => output), output);
    const [record] = await h.history.read(); assert.ok(record);
    await h.audit.close();
    const reopened = createAuditRuntime({ instanceName: h.instanceName, filePath: h.databasePath, eventBufferSize: 100 });
    try {
        assert.deepEqual(reopened.api.toolCalls.readQuery({ callIds: [record.callId] }), [record]);
        assert.deepEqual(record.output, output);
        assert.equal(record.ctxId, "durable-context"); assert.equal(record.requestId, "durable-request");
        assert.deepEqual(reopened.api.toolCalls.readQuery({ ctxId: "foreign-context" }), []);
        const [projected] = reopened.api.toolCalls.readQuery({ includeInput: false, includeOutput: false });
        assert.equal(projected?.output, undefined); assert.equal(projected?.input, undefined);
        assert.equal(projected?.callId, record.callId);
    } finally { await reopened.close(); }
});

test("round4: SQLite terminal insert failure preserves execution result and leaves scheduler reusable", async (t) => {
    const h = await round4Target(); t.after(() => h.close());
    h.audit.api.toolCalls.readQuery(); // Initialize the lazily opened schema before installing a real SQLite trigger.
    const fault = new DatabaseSync(h.databasePath); t.after(() => fault.close());
    fault.exec(`CREATE TRIGGER round4_fail_terminal BEFORE INSERT ON audit_records
        WHEN NEW.collection = 'toolCalls' BEGIN SELECT RAISE(ABORT, 'round4 disk write rejected'); END`);
    const warnings = t.mock.method(console, "warn", () => {});
    let executions = 0;
    h.runtime.hooks.registerExecute("local_effect", async () => ({ execution: ++executions }));
    assert.deepEqual(await h.runtime.api.call("round4", "local_effect", {}, { source: "cli", ctxId: "fault-context" }), { execution: 1 });
    assert.equal(h.history.hasActiveForContext("fault-context"), false);
    assert.equal(warnings.mock.callCount(), 1);
    assert.match(String(warnings.mock.calls[0]?.arguments[1]), /round4 disk write rejected/);
    fault.exec("DROP TRIGGER round4_fail_terminal");
    assert.deepEqual(await h.runtime.api.call("round4", "local_effect", {}, { source: "cli", ctxId: "healthy-context" }), { execution: 2 });
    const [record] = await h.history.read({ ctxId: "healthy-context" });
    assert.equal(record?.status, "completed"); assert.deepEqual(record?.output, { execution: 2 });
    assert.equal(executions, 2);
});
