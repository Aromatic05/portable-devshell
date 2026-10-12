import assert from "node:assert/strict";
import test from "node:test";
import { projectMcpAppActivity, readMcpAppActivity } from "../../src/mcpapp/Activity.ts";
import type { InstanceEventRecord, JsonValue } from "@portable-devshell/shared";

function event(seq: number, type: string, data: Record<string, JsonValue>): InstanceEventRecord {
    return { seq, type, at: new Date(seq * 1000).toISOString(),
        instanceName: "demo" as InstanceEventRecord["instanceName"], data };
}

test("Activity projects only audited ToolCalls for the selected Context", () => {
    const events = [
        event(1, "toolCall.queued", { ctxId: "ctx-target", callId: "a", toolName: "bash_run", inputSummary: "hidden command" }),
        event(2, "toolCall.completed", { ctxId: "ctx-other", callId: "b", toolName: "file_read" }),
        event(3, "toolCall.completed", { ctxId: "ctx-target", callId: "a", toolName: "bash_run", exitCode: 0 }),
        event(4, "toolCall.failed", { ctxId: "ctx-target", callId: "c", toolName: "file_edit", inputSummary: "secret" }),
        event(5, "goal.updated", { ctxId: "ctx-target" }),
        event(6, "toolCall.running", { callId: "unscoped", toolName: "bash_run" }),
    ];
    const projected = projectMcpAppActivity(events, "ctx-target");
    assert.deepEqual(projected.map((item) => [item.callId, item.name, item.state]), [
        ["c", "file_edit", "failed"], ["a", "bash_run", "completed"],
    ]);
    assert.equal(projected[1]?.exitCode, 0);
    assert.equal(JSON.stringify(projected).includes("hidden command"), false);
    assert.equal(JSON.stringify(projected).includes("secret"), false);
});

test("Activity reads Instance ledger tail and recovers after a retained-event gap", async () => {
    const requested: number[] = [];
    const projected = await readMcpAppActivity({
        readEvents: async (fromSeq) => {
            requested.push(fromSeq);
            if (requested.length === 1) return {
                kind: "gap", code: "stream.gap", fromSeq, nextSeq: 500, lastSeq: 501,
            };
            return { kind: "events", lastSeq: 501, events: [
                event(500, "toolCall.running", { ctxId: "ctx-target", callId: "next", toolName: "bash_run" }),
                event(501, "toolCall.denied", { ctxId: "ctx-other", callId: "other", toolName: "bash_run" }),
            ] };
        },
    }, "ctx-target", 501);
    assert.deepEqual(requested, [251, 500]);
    assert.equal(projected.length, 1);
    assert.equal(projected[0]?.name, "bash_run");
});
