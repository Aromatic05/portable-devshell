import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { errorCodes, asInstanceName, type InstanceEvent } from "@portable-devshell/shared";
import {
    InstanceEventBuffer,
    InstanceLogStore,
    InstancePaths,
    JsonlStore,
    ToolCallHistory,
    type InstanceLogEntry
} from "@portable-devshell/core";

test("JsonlStore appends and reads JSONL records", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-jsonl-"));

    try {
        const store = new JsonlStore<{ value: string }>(join(root, "records.jsonl"));
        await store.append({ value: "one" });
        await store.append({ value: "two" });

        assert.deepEqual(await store.readAll(), [{ value: "one" }, { value: "two" }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("InstanceEventBuffer replays from fromSeq and reports stream.gap", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-events-"));
    const instanceName = asInstanceName("task-5-events");

    try {
        const paths = new InstancePaths(instanceName, root);
        const store = new JsonlStore<InstanceEvent>(paths.eventsFile);
        const buffer = new InstanceEventBuffer(instanceName, 2, store);

        await buffer.append({ at: "2026-07-07T00:00:00.000Z", type: "instance.started" });
        await buffer.append({ at: "2026-07-07T00:00:01.000Z", type: "instance.statusChanged" });
        await buffer.append({ at: "2026-07-07T00:00:02.000Z", type: "toolCall.completed" });

        const replay = buffer.readFrom(2);
        assert.equal(replay.kind, "events");
        assert.deepEqual(replay.events.map((event) => event.seq), [2, 3]);
        assert.equal(replay.lastSeq, 3);

        const gap = buffer.readFrom(1);
        assert.equal(gap.kind, "gap");
        assert.equal(gap.code, errorCodes.streamGap);
        assert.equal(gap.nextSeq, 2);

        const reloaded = new InstanceEventBuffer(instanceName, 2, store);
        await reloaded.append({ at: "2026-07-07T00:00:03.000Z", type: "instance.statusChanged" });
        assert.equal(reloaded.lastSeq, 4);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("InstanceLogStore and ToolCallHistory persist per-instance records", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-storage-"));
    const instanceName = asInstanceName("task-5-storage");

    try {
        const paths = new InstancePaths(instanceName, root);
        const logStore = new InstanceLogStore(instanceName, new JsonlStore<InstanceLogEntry>(paths.logsFile));
        const history = new ToolCallHistory(instanceName, new JsonlStore(paths.toolCallsFile));

        const logEntry = await logStore.append("stdout", "hello", "2026-07-07T00:00:00.000Z", {
            callId: "call-1",
            requestId: "request-1",
            sessionId: "session-1",
            source: "mcp",
            toolName: "bash_run"
        });
        assert.equal(logEntry.seq, 1);
        assert.equal(logEntry.callId, "call-1");
        assert.equal(logEntry.requestId, "request-1");
        assert.equal(logEntry.sessionId, "session-1");
        assert.equal(logEntry.source, "mcp");
        assert.equal(logEntry.toolName, "bash_run");
        assert.deepEqual(await logStore.read({ fromSeq: 1 }), [logEntry]);

        await history.started(
            "call-1",
            "bash_run",
            "{\"command\":\"pwd\"}",
            { source: "cli" },
            "2026-07-07T00:00:01.000Z",
            "running",
            { taskId: "task-1", todoItemId: "implement" }
        );

        await history.started("call-2", "bash_run", "{\"command\":\"ls\"}", { source: "cli" }, "2026-07-07T00:00:02.000Z");
        assert.deepEqual((await history.read({ status: "running" })).map((record) => record.callId), ["call-1", "call-2"]);

        const completed = await history.completed(
            "call-1",
            "2026-07-07T00:00:03.000Z",
            { exitCode: 0, stderrBytes: 0, stdoutBytes: 2, termination: "exited" }
        );
        assert.equal(completed.status, "completed");
        assert.equal(completed.exitCode, 0);
        assert.equal(completed.stdoutBytes, 2);
        assert.equal(completed.termination, "exited");
        assert.equal(completed.inputSummary, "{\"command\":\"pwd\"}");
        assert.equal(completed.source, "cli");
        assert.equal(completed.taskId, "task-1");
        assert.equal(completed.todoItemId, "implement");

        const completedSecond = await history.completed(
            "call-2",
            "2026-07-07T00:00:03.500Z",
            { exitCode: 0, stderrBytes: 0, stdoutBytes: 3, termination: "exited" }
        );
        assert.equal(completedSecond.status, "completed");
        await history.started("call-3", "bash_run", "{\"command\":\"false\"}", { requestId: "req-3", source: "mcp" }, "2026-07-07T00:00:04.000Z");

        const failed = await history.failed(
            "call-3",
            "worker.command_failed",
            "2026-07-07T00:00:05.000Z",
            { exitCode: 1, stderrBytes: 4, stdoutBytes: 0, termination: "exited" }
        );
        assert.equal(failed.status, "failed");
        assert.equal(failed.error, "worker.command_failed");
        assert.equal(failed.requestId, "req-3");
        assert.equal(failed.source, "mcp");
        assert.equal(failed.stderrBytes, 4);

        const records = await history.read();
        assert.deepEqual(records.map((record) => record.callId), ["call-1", "call-2", "call-3"]);
        assert.deepEqual((await history.read({ limit: 1 })).map((record) => record.callId), ["call-3"]);
        assert.deepEqual((await history.read({ after: "call-1" })).map((record) => record.callId), ["call-2", "call-3"]);
        assert.deepEqual((await history.read({ before: "call-3", limit: 1 })).map((record) => record.callId), ["call-2"]);
        assert.deepEqual((await history.read({ source: "mcp" })).map((record) => record.callId), ["call-3"]);
        assert.deepEqual((await history.read({ status: "completed" })).map((record) => record.callId), ["call-1", "call-2"]);
        assert.deepEqual((await history.read({ toolName: "bash_run" })).map((record) => record.callId), ["call-1", "call-2", "call-3"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
