import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";

import { TuiRuntimeTmuxOperations } from "../../src/runtime/operation/TuiRuntimeTmuxOperations.ts";

interface RecordedCall {
    input: JsonValue;
    instance: string;
    toolName: string;
}

function createHarness(responder: (call: RecordedCall) => JsonValue) {
    const calls: RecordedCall[] = [];
    const operations = new TuiRuntimeTmuxOperations({
        clients: {
            tool: {
                async call(instance: string, toolName: string, input: JsonValue): Promise<JsonValue> {
                    const call: RecordedCall = { input, instance, toolName };
                    calls.push(call);
                    return responder(call);
                }
            }
        } as never,
        operationTimeoutMs: 1000
    });
    return { calls, operations };
}

test("listPanes records a tmux_list call and preserves each task's actual status", async () => {
    const harness = createHarness((): JsonValue => ({
        panes: [
            { id: "%0", name: "main", status: "idle" },
            { id: "%1", name: "server", status: "running", task: { id: "task-9", status: "running" } },
            { id: "%2", name: "done", status: "0", task: { id: "task-5", status: "0" } }
        ]
    }));

    const panes = await harness.operations.listPanes("alpha");

    assert.deepEqual(harness.calls, [{ input: {}, instance: "alpha", toolName: "tmux_list" }]);
    assert.deepEqual(panes, [
        { id: "%0", name: "main", status: "idle" },
        { id: "%1", name: "server", status: "running", task: { id: "task-9", status: "running" } },
        { id: "%2", name: "done", status: "0", task: { id: "task-5", status: "0" } }
    ]);
});

test("inspectPane records a tmux_inspect call scoped to the requested pane and line window", async () => {
    const harness = createHarness((call): JsonValue => {
        assert.deepEqual(call.input, { end: 0, pane: "server", start: -50 });
        return {
            panes: [
                {
                    command: "node server.js",
                    cwd: "/work",
                    id: "%1",
                    lines: ["one", "two"],
                    locked: false,
                    name: "server",
                    status: "running",
                    task: { id: "task-9", status: "running" }
                }
            ]
        };
    });

    const detail = await harness.operations.inspectPane("alpha", "server", 50);

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0]?.toolName, "tmux_inspect");
    assert.equal(harness.calls[0]?.instance, "alpha");
    assert.deepEqual(detail, {
        command: "node server.js",
        cwd: "/work",
        id: "%1",
        lines: ["one", "two"],
        locked: false,
        name: "server",
        status: "running",
        taskId: "task-9",
        taskStatus: "running"
    });
});

test("inspectPane clamps the requested window to the worker maximum of 200 lines", async () => {
    const harness = createHarness((): JsonValue => ({ panes: [] }));

    await harness.operations.inspectPane("alpha", "server", 5000);

    assert.deepEqual(harness.calls[0]?.input, { end: 0, pane: "server", start: -200 });
});

test("inspectPane returns undefined when the worker no longer reports the pane", async () => {
    const harness = createHarness((): JsonValue => ({ panes: [{ id: "%0", name: "main", status: "idle" }] }));

    const detail = await harness.operations.inspectPane("alpha", "gone", 50);

    assert.equal(detail, undefined);
    assert.equal(harness.calls[0]?.toolName, "tmux_inspect");
});

test("sendInput records a tmux_input call addressed to the running task", async () => {
    const harness = createHarness((call): JsonValue => {
        assert.deepEqual(call.input, { input: "hello^M", task: "task-9", timeMs: 0 });
        return { output: ["hello"], task: { id: "task-9", status: "running" } };
    });

    const result = await harness.operations.sendInput("alpha", "task-9", "hello^M");

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0]?.toolName, "tmux_input");
    assert.equal(harness.calls[0]?.instance, "alpha");
    assert.deepEqual(result, { output: ["hello"], status: "running", task: "task-9" });
});

test("sendInput reports the terminal task status returned by the worker", async () => {
    const harness = createHarness((): JsonValue => ({ output: ["bye"], task: { id: "task-9", status: "0" } }));

    const result = await harness.operations.sendInput("alpha", "task-9", "^D");

    assert.deepEqual(result, { output: ["bye"], status: "0", task: "task-9" });
});

test("tmux operations surface a coded worker error instead of parsing it as data", async () => {
    const harness = createHarness((): JsonValue => ({
        error: { code: "tmux.paneNotFound", message: "no such pane" }
    }));

    await assert.rejects(
        () => harness.operations.inspectPane("alpha", "missing", 50),
        /tmux\.paneNotFound: no such pane/u
    );
});

test("inspectPane gives an exact pane id precedence over another pane's matching name", async () => {
    const harness = createHarness((): JsonValue => ({
        panes: [
            { id: "%1", name: "%2", status: "idle", lines: ["wrong"] },
            { id: "%2", name: "target", status: "running", lines: ["right"] }
        ]
    }));

    const detail = await harness.operations.inspectPane("alpha", "%2", 50);

    assert.equal(detail?.id, "%2");
    assert.equal(detail?.name, "target");
    assert.deepEqual(detail?.lines, ["right"]);
});
