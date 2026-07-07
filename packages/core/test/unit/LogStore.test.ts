import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { errorCodes, asInstanceName, type InstanceEvent } from "@portable-devshell/shared";
import {
    InstanceBusyError,
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
        await buffer.append({ at: "2026-07-07T00:00:02.000Z", type: "instance.toolCalled" });

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

        const logEntry = await logStore.append("stdout", "hello", "2026-07-07T00:00:00.000Z");
        assert.equal(logEntry.seq, 1);
        assert.deepEqual(await logStore.read({ fromSeq: 1 }), [logEntry]);

        const started = await history.started("call-1", "bash_run", ["pwd"], "2026-07-07T00:00:01.000Z");
        assert.equal(started.status, "started");

        await assert.rejects(
            history.started("call-2", "bash_run", ["ls"], "2026-07-07T00:00:02.000Z"),
            (error: unknown) => {
                assert.ok(error instanceof InstanceBusyError);
                assert.equal(error.code, errorCodes.coreInstanceBusy);
                return true;
            }
        );

        const completed = await history.completed(
            "call-1",
            { exitCode: 0, signal: undefined, stderr: "", stdout: "ok" },
            "2026-07-07T00:00:03.000Z"
        );
        assert.equal(completed.status, "completed");
        assert.equal(completed.result?.stdout, "ok");

        const failedStarted = await history.started("call-3", "bash_run", ["false"], "2026-07-07T00:00:04.000Z");
        assert.equal(failedStarted.status, "started");

        const failed = await history.failed(
            "call-3",
            "worker.command_failed",
            "2026-07-07T00:00:05.000Z",
            { exitCode: 1, signal: undefined, stderr: "boom", stdout: "" }
        );
        assert.equal(failed.status, "failed");
        assert.equal(failed.errorCode, "worker.command_failed");

        const records = await history.read();
        assert.deepEqual(records.map((record) => record.status), ["started", "completed", "started", "failed"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
