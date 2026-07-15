import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { errorCodes, asInstanceName, type InstanceEvent } from "@portable-devshell/shared";
import {
    InstanceEventBuffer,
    InstanceLogStore,
    InstancePaths,
    AuditDatabase,
    ToolCallHistory,
    type InstanceLogEntry
} from "@portable-devshell/core";

const MIB = 1024 * 1024;

test("AuditDatabase appends and reads records", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-sqlite-"));

    try {
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-15T00:00:00.000Z"),
            retentionDays: 30
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            timestamp: (record) => record.at
        });
        await store.append({ at: "2026-07-15T00:00:00.000Z", value: "one" });
        await store.append({ at: "2026-07-15T00:00:01.000Z", value: "two" });

        assert.deepEqual(await store.readAll(), [
            { at: "2026-07-15T00:00:00.000Z", value: "one" },
            { at: "2026-07-15T00:00:01.000Z", value: "two" }
        ]);
        assert.equal(database.stats().recordCount, 2);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase migrates legacy JSONL exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-sqlite-migrate-"));
    const legacyFile = join(root, "logs.jsonl");
    const databaseFile = join(root, "audit.sqlite3");

    try {
        await writeFile(
            legacyFile,
            `${JSON.stringify({ at: "2026-07-15T00:00:00.000Z", value: "legacy" })}\n`,
            "utf8"
        );
        const database = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-15T00:00:00.000Z"),
            retentionDays: 30
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            legacyFile,
            timestamp: (record) => record.at
        });

        await assert.rejects(access(legacyFile), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
        assert.deepEqual(await store.readAll(), [{ at: "2026-07-15T00:00:00.000Z", value: "legacy" }]);
        database.close();

        const reopened = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-15T00:00:00.000Z"),
            retentionDays: 30
        });
        const reopenedStore = reopened.store<{ at: string; value: string }>("logs", {
            legacyFile,
            timestamp: (record) => record.at
        });
        assert.deepEqual(await reopenedStore.readAll(), [{ at: "2026-07-15T00:00:00.000Z", value: "legacy" }]);
        reopened.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase removes expired rows on read and evicts oldest rows above maxBytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-sqlite-cleanup-"));
    let now = Date.parse("2026-07-15T00:00:00.000Z");

    try {
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 16 * MIB,
            now: () => now,
            retentionDays: 7
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            timestamp: (record) => record.at
        });
        await store.append({ at: "2026-07-01T00:00:00.000Z", value: "expired" });
        await store.append({ at: "2026-07-15T00:00:00.000Z", value: "current" });
        assert.deepEqual((await store.readAll()).map((record) => record.value), ["current"]);

        const large = "x".repeat(6 * MIB);
        await store.append({ at: "2026-07-15T00:00:01.000Z", value: `first-${large}` });
        await store.append({ at: "2026-07-15T00:00:02.000Z", value: `second-${large}` });
        await store.append({ at: "2026-07-15T00:00:03.000Z", value: `third-${large}` });
        const retained = await store.readAll();
        assert.equal(retained.some((record) => record.value.startsWith("first-")), false);
        assert.equal(retained.at(-1)?.value.startsWith("third-"), true);
        assert.equal(database.stats().payloadBytes <= 16 * MIB, true);
        assert.equal(database.stats().fileBytes <= 16 * MIB, true);
        now += 8 * 24 * 60 * 60 * 1000;
        assert.deepEqual(await store.readAll(), []);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("InstanceEventBuffer replays from fromSeq and reports stream.gap", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-events-"));
    const instanceName = asInstanceName("task-5-events");

    try {
        const paths = new InstancePaths(instanceName, root);
        const database = new AuditDatabase(paths.auditDatabaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-07T00:00:10.000Z"),
            retentionDays: 30
        });
        const store = database.store<InstanceEvent>("events", {
            legacyFile: paths.legacyEventsFile,
            sequence: (record) => record.seq,
            timestamp: (record) => record.at
        });
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
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("InstanceLogStore and ToolCallHistory persist per-instance records", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-storage-"));
    const instanceName = asInstanceName("task-5-storage");

    try {
        const paths = new InstancePaths(instanceName, root);
        const database = new AuditDatabase(paths.auditDatabaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-07T00:00:10.000Z"),
            retentionDays: 30
        });
        const logStore = new InstanceLogStore(
            instanceName,
            database.store<InstanceLogEntry>("logs", {
                legacyFile: paths.legacyLogsFile,
                sequence: (record) => record.seq,
                timestamp: (record) => record.at
            })
        );
        const history = new ToolCallHistory(
            instanceName,
            database.store("toolCalls", {
                legacyFile: paths.legacyToolCallsFile,
                timestamp: (record) => record.completedAt ?? record.startedAt
            })
        );

        const logEntry = await logStore.append("stdout", "hello", "2026-07-07T00:00:00.000Z", {
            callId: "call-1",
            requestId: "request-1",
            ctxId: "context-1",
            source: "mcp",
            toolName: "bash_run"
        });
        assert.equal(logEntry.seq, 1);
        assert.equal(logEntry.callId, "call-1");
        assert.equal(logEntry.requestId, "request-1");
        assert.equal(logEntry.ctxId, "context-1");
        assert.equal(logEntry.source, "mcp");
        assert.equal(logEntry.toolName, "bash_run");
        assert.deepEqual(await logStore.read({ fromSeq: 1 }), [logEntry]);

        const patch = "*** Begin Patch\n*** Update File: src/example.ts\n" + "+line\n".repeat(120) + "*** End Patch";
        await history.started(
            "call-1",
            "bash_run",
            "{\"command\":\"pwd\"}",
            { source: "cli" },
            "2026-07-07T00:00:01.000Z",
            "running",
            { taskId: "task-1", todoItemId: "implement" },
            { input: patch }
        );

        await history.started("call-2", "bash_run", "{\"command\":\"ls\"}", { source: "cli" }, "2026-07-07T00:00:02.000Z");
        assert.deepEqual((await history.read({ status: "running" })).map((record) => record.callId), ["call-1", "call-2"]);

        const completed = await history.completed(
            "call-1",
            "2026-07-07T00:00:03.000Z",
            { exitCode: 0, output: { stdout: "ok" }, stderrBytes: 0, stdoutBytes: 2, termination: "exited" }
        );
        assert.equal(completed.status, "completed");
        assert.equal(completed.exitCode, 0);
        assert.equal(completed.stdoutBytes, 2);
        assert.equal(completed.termination, "exited");
        assert.equal(completed.inputSummary, "{\"command\":\"pwd\"}");
        assert.equal((completed.input as { input?: unknown } | undefined)?.input, patch);
        assert.deepEqual(completed.output, { stdout: "ok" });
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
            { exitCode: 1, output: { stderr: "fail" }, stderrBytes: 4, stdoutBytes: 0, termination: "exited" }
        );
        assert.equal(failed.status, "failed");
        assert.equal(failed.error, "worker.command_failed");
        assert.equal(failed.requestId, "req-3");
        assert.equal(failed.source, "mcp");
        assert.equal(failed.stderrBytes, 4);
        assert.deepEqual(failed.output, { stderr: "fail" });

        const records = await history.read();
        assert.deepEqual(records.map((record) => record.callId), ["call-1", "call-2", "call-3"]);
        assert.deepEqual((await history.read({ limit: 1 })).map((record) => record.callId), ["call-3"]);
        assert.deepEqual((await history.read({ after: "call-1" })).map((record) => record.callId), ["call-2", "call-3"]);
        assert.deepEqual((await history.read({ before: "call-3", limit: 1 })).map((record) => record.callId), ["call-2"]);
        assert.deepEqual((await history.read({ source: "mcp" })).map((record) => record.callId), ["call-3"]);
        assert.deepEqual((await history.read({ status: "completed" })).map((record) => record.callId), ["call-1", "call-2"]);
        assert.deepEqual((await history.read({ toolName: "bash_run" })).map((record) => record.callId), ["call-1", "call-2", "call-3"]);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
