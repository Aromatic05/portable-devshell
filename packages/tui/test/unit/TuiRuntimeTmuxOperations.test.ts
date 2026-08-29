import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";

import { TuiRuntimeTmuxOperations } from "../../src/runtime/operation/TuiRuntimeTmuxOperations.ts";
import { TuiAppStore } from "../../src/state/TuiAppStore.ts";

interface RecordedCall {
    input: JsonValue;
    instance: string;
    toolName: string;
    workspace: string;
}

function createHarness(responder: (call: RecordedCall) => JsonValue) {
    const calls: RecordedCall[] = [];
    const store = new TuiAppStore();
    store.patchControlReadModel({
        instances: [{ enabled: true, homeDirectory: "/home/alpha", mcpEnabled: true, name: "alpha" }]
    });
    const operations = new TuiRuntimeTmuxOperations({
        clients: {
            tool: {
                async call(instance: string, toolName: string, input: JsonValue, workspace: string): Promise<JsonValue> {
                    const call: RecordedCall = { input, instance, toolName, workspace };
                    calls.push(call);
                    return responder(call);
                }
            }
        } as never,
        operationTimeoutMs: 1000,
        store
    });
    return { calls, operations, store };
}

test("listPanes records a tmux_list call and preserves each task's actual status", async () => {
    const harness = createHarness((): JsonValue => ({
        panes: [
            { id: "%0", name: "main", status: "idle" },
            { id: "%1", name: "server", status: "running", task: { id: "task-9", status: "running" } },
            { id: "%2", name: "done", status: "0", task: { id: "task-5", status: "0" } }
        ]
    }));
    harness.store.patchControlReadModel({
        instanceState: {
            alpha: {
                toolCalls: [{
                    callId: "call-home-tmux",
                    inputSummary: "{}",
                    instance: "alpha",
                    source: "mcp",
                    startedAt: "2026-08-29T08:00:00.000Z",
                    status: "completed",
                    toolName: "tmux_list",
                    workspace: "/home/alpha"
                } as never]
            }
        }
    });

    const panes = await harness.operations.listPanes("alpha");

    assert.deepEqual(harness.calls, [{ input: {}, instance: "alpha", toolName: "tmux_list", workspace: "/home/alpha" }]);
    assert.deepEqual(panes, [
        { id: "%1", name: "server", status: "running", task: { id: "task-9", status: "running" }, workspace: "/home/alpha" },
        { id: "%2", name: "done", status: "0", task: { id: "task-5", status: "0" }, workspace: "/home/alpha" },
        { id: "%0", name: "main", status: "idle", workspace: "/home/alpha" }
    ]);
});

test("listPanes discovers tmux task workspaces from recent tool calls instead of only querying the instance home", async () => {
    const harness = createHarness((call): JsonValue => ({
        panes: call.workspace === "/work/project"
            ? [{ id: "%7", name: "task-pane", status: "running", task: { id: "task-project", status: "running" } }]
            : [{ id: "%0", name: "main", status: "idle" }]
    }));
    harness.store.patchControlReadModel({
        instanceState: {
            alpha: {
                toolCalls: [{
                    callId: "call-tmux",
                    inputSummary: "{}",
                    instance: "alpha",
                    source: "mcp",
                    startedAt: "2026-08-29T08:00:00.000Z",
                    status: "completed",
                    toolName: "tmux_run",
                    workspace: "/work/project"
                } as never]
            }
        }
    });

    const panes = await harness.operations.listPanes("alpha");

    assert.deepEqual(harness.calls.map((call) => call.workspace), ["/work/project"]);
    assert.equal(panes[0]?.task?.id, "task-project");
    assert.equal(panes[0]?.workspace, "/work/project");
});

test("listPanes does not probe ordinary Context workspaces or home without tmux evidence", async () => {
    const harness = createHarness((): JsonValue => ({ panes: [{ id: "%0", name: "main", status: "idle" }] }));
    harness.store.patchControlReadModel({
        contexts: [{
            createdAt: "2026-08-29T08:00:00.000Z",
            ctxId: "ctx-ordinary",
            environments: [{ instance: "alpha", workspace: "/work/ordinary" }],
            expiresAt: "2026-08-31T08:00:00.000Z",
            instance: "alpha",
            lastAccessedAt: "2026-08-29T08:00:00.000Z",
            principal: "subject",
            status: "active",
            workspace: "/work/ordinary"
        } as never]
    });

    const panes = await harness.operations.listPanes("alpha");

    assert.deepEqual(panes, []);
    assert.deepEqual(harness.calls, []);
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

    const detail = await harness.operations.inspectPane("alpha", "/work/server", "server", 50);

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
        taskStatus: "running",
        workspace: "/work/server"
    });
});

test("inspectPane clamps the requested window to the worker maximum of 200 lines", async () => {
    const harness = createHarness((): JsonValue => ({ panes: [] }));

    await harness.operations.inspectPane("alpha", "/work/server", "server", 5000);

    assert.deepEqual(harness.calls[0]?.input, { end: 0, pane: "server", start: -200 });
});

test("inspectPane returns undefined when the worker no longer reports the pane", async () => {
    const harness = createHarness((): JsonValue => ({ panes: [{ id: "%0", name: "main", status: "idle" }] }));

    const detail = await harness.operations.inspectPane("alpha", "/work/server", "gone", 50);

    assert.equal(detail, undefined);
    assert.equal(harness.calls[0]?.toolName, "tmux_inspect");
});

test("sendInput records a tmux_input call addressed to the running task", async () => {
    const harness = createHarness((call): JsonValue => {
        assert.deepEqual(call.input, { input: "hello^M", task: "task-9", timeMs: 0 });
        return { output: ["hello"], task: { id: "task-9", status: "running" } };
    });

    const result = await harness.operations.sendInput("alpha", "/work/server", "task-9", "hello^M");

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0]?.toolName, "tmux_input");
    assert.equal(harness.calls[0]?.instance, "alpha");
    assert.deepEqual(result, { output: ["hello"], status: "running", task: "task-9" });
});

test("sendInput reports the terminal task status returned by the worker", async () => {
    const harness = createHarness((): JsonValue => ({ output: ["bye"], task: { id: "task-9", status: "0" } }));

    const result = await harness.operations.sendInput("alpha", "/work/server", "task-9", "^D");

    assert.deepEqual(result, { output: ["bye"], status: "0", task: "task-9" });
});

test("tmux operations surface a coded worker error instead of parsing it as data", async () => {
    const harness = createHarness((): JsonValue => ({
        error: { code: "tmux.paneNotFound", message: "no such pane" }
    }));

    await assert.rejects(
        () => harness.operations.inspectPane("alpha", "/work/server", "missing", 50),
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

    const detail = await harness.operations.inspectPane("alpha", "/work/server", "%2", 50);

    assert.equal(detail?.id, "%2");
    assert.equal(detail?.name, "target");
    assert.deepEqual(detail?.lines, ["right"]);
});
