import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { errorCodes, asInstanceName, type InstanceEvent, type ToolCallRecord } from "@portable-devshell/shared";
import {
    InstanceEventBuffer,
    LogStoreInstance,
    InstancePaths,
    AuditDatabase,
    AuditToolCallHistory,
    type InstanceLogEntry
} from "@portable-devshell/core/testing";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const MIB = 1024 * 1024;

test("AuditDatabase appends and reads records", async () => {
    const root = await createTestTempDirectory("sqlite");

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
        assert.deepEqual(await store.readTail?.(1), [
            { at: "2026-07-15T00:00:01.000Z", value: "two" }
        ]);
        assert.equal(database.stats().recordCount, 2);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase defers SQLite creation until the first durable access", async () => {
    const root = await createTestTempDirectory("sqlite-lazy-open");
    const databaseFile = join(root, "nested", "audit.sqlite3");

    try {
        const database = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-15T00:00:00.000Z"),
            retentionDays: 30
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            timestamp: (record) => record.at
        });
        await assert.rejects(access(databaseFile), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
        assert.deepEqual(await store.readAll(), []);
        await access(databaseFile);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase uses WAL and accounts the WAL sidecar in fileBytes", async () => {
    const root = await createTestTempDirectory("sqlite-wal");
    const databaseFile = join(root, "audit.sqlite3");

    try {
        const database = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-15T00:00:00.000Z"),
            retentionDays: 30
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            timestamp: (record) => record.at
        });
        await store.append({ at: "2026-07-15T00:00:00.000Z", value: "wal-record" });

        assert.equal((await stat(`${databaseFile}-wal`)).size > 0, true);
        const stats = database.stats();
        const mainBytes = (await stat(databaseFile)).size;
        const walBytes = await stat(`${databaseFile}-wal`).then((value) => value.size).catch(() => 0);
        assert.equal(stats.fileBytes, mainBytes + walBytes);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase compresses large log messages and restores them transparently", async () => {
    const root = await createTestTempDirectory("sqlite-log-zstd");
    const instanceName = asInstanceName("sqlite-log-zstd");
    const message = "cargo: compiling portable-devshell dependency graph\n".repeat(2_048);

    try {
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-09-01T12:00:00.000Z"),
            retentionDays: 30
        });
        const store = database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at
        });
        const record: InstanceLogEntry = {
            at: "2026-09-01T12:00:00.000Z",
            callId: "call-zstd",
            instanceName,
            message,
            seq: 1,
            stream: "stdout",
            toolName: "bash_run"
        };

        await store.append(record);

        assert.deepEqual(await store.readAll(), [record]);
        assert.deepEqual(await store.readFromSeq?.(1, 1), [record]);
        assert.equal(database.stats().payloadBytes < Buffer.byteLength(message, "utf8") / 4, true);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase stores large incompressible log messages as identity bodies", async () => {
    const root = await createTestTempDirectory("sqlite-log-identity");
    const databaseFile = join(root, "audit.sqlite3");
    const instanceName = asInstanceName("sqlite-log-identity");
    const message = randomBytes(64 * 1024).toString("base64");

    try {
        const database = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-09-01T12:00:00.000Z"),
            retentionDays: 30
        });
        const store = database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at
        });
        const record: InstanceLogEntry = {
            at: "2026-09-01T12:00:00.000Z",
            instanceName,
            message,
            seq: 1,
            stream: "stdout"
        };

        await store.append(record);
        assert.deepEqual(await store.readAll(), [record]);
        database.close();

        const row = readStoredAuditRow(databaseFile);
        assert.equal(row.bodyCodec, "identity");
        assert.equal(row.payload.includes("\"message\""), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase stops decoding sequenced logs after satisfying the decoded byte budget", async () => {
    const root = await createTestTempDirectory("sqlite-log-budget");
    const instanceName = asInstanceName("sqlite-log-budget");
    const message = "x".repeat(700 * 1024);

    try {
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-09-01T12:00:00.000Z"),
            retentionDays: 30
        });
        const store = database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at
        });
        for (let seq = 1; seq <= 3; seq += 1) {
            await store.append({
                at: `2026-09-01T12:00:0${seq}.000Z`,
                instanceName,
                message,
                seq,
                stream: "stdout"
            });
        }

        assert.equal((await store.readFromSeq?.(1, 100, MIB))?.length, 2);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase upgrades v1 SQLite rows without rewriting historical log payloads", async () => {
    const root = await createTestTempDirectory("sqlite-v1-upgrade");
    const databaseFile = join(root, "audit.sqlite3");
    const instanceName = asInstanceName("sqlite-v1-upgrade");
    const legacy: InstanceLogEntry = {
        at: "2026-09-01T11:00:00.000Z",
        instanceName,
        message: "historical inline stdout\n",
        seq: 1,
        stream: "stdout"
    };

    try {
        createV1AuditDatabase(databaseFile, legacy);
        const database = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-09-01T12:00:00.000Z"),
            retentionDays: 30
        });
        const store = database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at
        });
        const compressed: InstanceLogEntry = {
            ...legacy,
            at: "2026-09-01T12:00:00.000Z",
            message: "new compressed stdout\n".repeat(2_048),
            seq: 2
        };

        assert.deepEqual(await store.readAll(), [legacy]);
        await store.append(compressed);
        assert.deepEqual(await store.readAll(), [legacy, compressed]);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditToolCallHistory uses bounded storage reads for unfiltered limited history", async () => {
    const instanceName = asInstanceName("bounded-history");
    const record = {
        callId: "call-tail",
        inputSummary: "{}",
        instance: instanceName,
        source: "cli" as const,
        startedAt: "2026-09-01T00:00:00.000Z",
        status: "completed" as const,
        toolName: "bash_run",
    };
    let readTailLimit = 0;
    const history = new AuditToolCallHistory(instanceName, {
        async append() {},
        async readAll() {
            throw new Error("unbounded audit read should not run");
        },
        async readTail(limit: number) {
            readTailLimit = limit;
            return [record];
        },
    });

    assert.deepEqual(await history.read({ limit: 200 }), [record]);
    assert.equal(readTailLimit, 200);
});

test("AuditToolCallHistory pushes filtered limited history into storage", async () => {
    const instanceName = asInstanceName("filtered-history");
    const record: ToolCallRecord = {
        callId: "call-filtered",
        ctxId: "ctx-filtered",
        inputSummary: "{}",
        instance: instanceName,
        source: "mcp",
        startedAt: "2026-09-01T00:00:00.000Z",
        status: "completed",
        toolName: "bash_run",
    };
    let storageQuery: unknown;
    const history = new AuditToolCallHistory(instanceName, {
        async append() {},
        async readAll() {
            throw new Error("unbounded audit read should not run");
        },
        async readQuery(query) {
            storageQuery = query;
            return [record];
        },
    });

    assert.deepEqual(await history.read({ ctxId: "ctx-filtered", limit: 64 }), [record]);
    assert.deepEqual(storageQuery, { ctxId: "ctx-filtered", limit: 64 });
});

test("AuditToolCallHistory keeps cursor pagination bounded while merging active calls", async () => {
    const instanceName = asInstanceName("cursor-history");
    const persisted: ToolCallRecord = {
        callId: "persisted-2",
        ctxId: "ctx-cursor",
        inputSummary: "{}",
        instance: instanceName,
        source: "mcp",
        startedAt: "2026-09-01T00:00:02.000Z",
        status: "completed",
        toolName: "bash_run",
    };
    let readAllCalled = false;
    const history = new AuditToolCallHistory(instanceName, {
        async append() {},
        async hasCall(callId) { return callId === "persisted-1"; },
        async readAll() { readAllCalled = true; return []; },
        async readQuery(query) {
            assert.deepEqual(query, { after: "persisted-1", ctxId: "ctx-cursor", limit: 2 });
            return [persisted];
        },
    });
    await history.started(
        "active-1",
        "bash_run",
        "{}",
        { ctxId: "ctx-cursor", source: "mcp" },
        "2026-09-01T00:00:03.000Z",
    );

    assert.deepEqual(
        (await history.read({ after: "persisted-1", ctxId: "ctx-cursor", limit: 2 })).map((record) => record.callId),
        ["persisted-2", "active-1"],
    );
    assert.equal(readAllCalled, false);
});

test("AuditToolCallHistory can exclude the detached wait owner from Context activity", async () => {
    const instanceName = asInstanceName("active-context-exclusion");
    const history = new AuditToolCallHistory(instanceName, {
        async append() {},
        async readAll() { return []; },
    });
    await history.started(
        "call-wait-owner",
        "tmux_run",
        "{}",
        { ctxId: "ctx-active", source: "mcp" },
        "2026-09-01T00:00:00.000Z",
    );
    assert.equal(history.hasActiveForContext("ctx-active"), true);
    assert.equal(history.hasActiveForContext("ctx-active", "call-wait-owner"), false);

    await history.started(
        "call-concurrent",
        "file_read",
        "{}",
        { ctxId: "ctx-active", source: "mcp" },
        "2026-09-01T00:00:01.000Z",
    );
    assert.equal(history.hasActiveForContext("ctx-active", "call-wait-owner"), true);
});

test("AuditDatabase queries bounded tool-call history and failure summaries without materializing all records", async () => {
    const root = await createTestTempDirectory("sqlite-tool-query");
    const instanceName = asInstanceName("sqlite-tool-query");
    const now = Date.parse("2026-09-01T12:00:00.000Z");

    try {
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 16 * MIB,
            now: () => now,
            retentionDays: 30
        });
        const store = database.toolCallStore({
            timestamp: (record) => record.completedAt ?? record.startedAt
        });
        const records: ToolCallRecord[] = [
            {
                callId: "ctx-a-old",
                completedAt: "2026-08-31T13:00:00.000Z",
                ctxId: "ctx-a",
                inputSummary: "{}",
                instance: instanceName,
                source: "mcp",
                startedAt: "2026-08-31T12:59:00.000Z",
                status: "failed",
                toolName: "bash_run",
            },
            {
                callId: "ctx-b",
                completedAt: "2026-09-01T10:00:00.000Z",
                ctxId: "ctx-b",
                inputSummary: "{}",
                instance: instanceName,
                source: "mcp",
                startedAt: "2026-09-01T09:59:00.000Z",
                status: "completed",
                toolName: "bash_run",
            },
            {
                callId: "ctx-a-latest",
                completedAt: "2026-09-01T11:00:00.000Z",
                ctxId: "ctx-a",
                inputSummary: "{}",
                instance: instanceName,
                source: "mcp",
                startedAt: "2026-09-01T10:59:00.000Z",
                status: "queueTimeout",
                toolName: "tmux_run",
            },
        ];
        for (const record of records) await store.append(record);

        assert.deepEqual(
            (await store.readQuery({ ctxId: "ctx-a", limit: 1 })).map((record) => record.callId),
            ["ctx-a-latest"],
        );
        assert.deepEqual(
            (await store.readQuery({ source: "mcp", status: "completed", toolName: "bash_run" }))
                .map((record) => record.callId),
            ["ctx-b"],
        );
        assert.deepEqual(
            await store.readFailureSummary(now - 24 * 60 * 60 * 1_000, now),
            { count: 2, latest: records[2] },
        );
        assert.deepEqual(
            (await store.readQuery({ after: "ctx-a-old", limit: 1 })).map((record) => record.callId),
            ["ctx-b"],
        );
        assert.deepEqual(
            (await store.readQuery({ before: "ctx-a-latest", limit: 1 })).map((record) => record.callId),
            ["ctx-b"],
        );
        assert.deepEqual(
            (await store.readQuery({ after: "ctx-a-old", before: "ctx-a-latest", status: "completed" }))
                .map((record) => record.callId),
            ["ctx-b"],
        );
        assert.deepEqual(await store.readQuery({ after: "missing", limit: 1 }), []);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase migrates legacy JSONL exactly once", async () => {
    const root = await createTestTempDirectory("sqlite-migrate");
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

        await access(legacyFile);
        assert.deepEqual(await store.readAll(), [{ at: "2026-07-15T00:00:00.000Z", value: "legacy" }]);
        await assert.rejects(access(legacyFile), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
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
    const root = await createTestTempDirectory("sqlite-cleanup");
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
    const root = await createTestTempDirectory("events");
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

test("InstanceEventBuffer does not advance memory state when durable append fails", async () => {
    const instanceName = asInstanceName("event-persist-failure");
    let failNext = true;
    const persisted: InstanceEvent[] = [];
    const store = {
        async append(record: InstanceEvent) {
            if (failNext) {
                failNext = false;
                throw new Error("audit unavailable");
            }
            persisted.push(record);
        },
        async readAll() { return [...persisted]; },
        async readHighWater() { return persisted.at(-1)?.seq ?? 0; },
    } as never;
    const buffer = new InstanceEventBuffer(instanceName, 8, store);

    await assert.rejects(
        buffer.append({ at: "2026-08-13T00:00:00.000Z", type: "instance.started" }),
        /audit unavailable/u,
    );
    assert.equal(buffer.lastSeq, 0);
    assert.deepEqual(buffer.readFrom(1), { events: [], kind: "events", lastSeq: 0 });

    const appended = await buffer.append({ at: "2026-08-13T00:00:01.000Z", type: "instance.started" });
    assert.equal(appended.seq, 1);
    assert.equal(buffer.lastSeq, 1);
    assert.deepEqual(persisted.map((event) => event.seq), [1]);
});

test("InstanceEventBuffer restores only its bounded tail from durable storage", async () => {
    const instanceName = asInstanceName("event-tail-restore");
    const persisted: InstanceEvent[] = Array.from({ length: 20 }, (_, index) => ({
        at: `2026-08-13T00:00:${String(index).padStart(2, "0")}.000Z`,
        instanceName,
        seq: index + 1,
        type: "instance.statusChanged",
    }));
    let tailLimit = 0;
    const store = {
        async append(record: InstanceEvent) { persisted.push(record); },
        async readAll() { throw new Error("unbounded event read should not run"); },
        async readHighWater() { return 20; },
        async readTail(limit: number) {
            tailLimit = limit;
            return persisted.slice(-limit);
        },
    } as never;
    const buffer = new InstanceEventBuffer(instanceName, 4, store);

    const appended = await buffer.append({
        at: "2026-08-13T00:01:00.000Z",
        type: "instance.statusChanged",
    });

    assert.equal(tailLimit, 4);
    assert.equal(appended.seq, 21);
    const replay = buffer.readFrom(18);
    assert.equal(replay.kind, "events");
    if (replay.kind !== "events") assert.fail("expected event replay");
    assert.deepEqual(replay.events.map((event) => event.seq), [18, 19, 20, 21]);
});

test("LogStoreInstance pushes fromSeq and limit into sequenced storage", async () => {
    const instanceName = asInstanceName("log-range-read");
    const entries: InstanceLogEntry[] = Array.from({ length: 5 }, (_, index) => ({
        at: `2026-08-13T00:00:0${index}.000Z`,
        instanceName,
        message: `line-${index + 1}`,
        seq: index + 1,
        stream: "stdout",
    }));
    let range: [number, number | undefined] | undefined;
    const store = {
        async append() {},
        async readAll() { throw new Error("unbounded log read should not run"); },
        async readFromSeq(fromSeq: number, limit?: number) {
            range = [fromSeq, limit];
            return entries.filter((entry) => entry.seq >= fromSeq).slice(0, limit);
        },
        async readHighWater() { return 5; },
        async readTail() { return entries.slice(-1); },
    } as never;
    const logs = new LogStoreInstance(instanceName, store);

    assert.deepEqual(
        (await logs.read({ fromSeq: 3, limit: 2 })).map((entry) => entry.seq),
        [3, 4],
    );
    assert.deepEqual(range, [3, 2]);
});

test("LogStoreInstance and AuditToolCallHistory write and query per-instance records", async () => {
    const root = await createTestTempDirectory("storage");
    const instanceName = asInstanceName("task-5-storage");

    try {
        const paths = new InstancePaths(instanceName, root);
        const database = new AuditDatabase(paths.auditDatabaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-07T00:00:10.000Z"),
            retentionDays: 30
        });
        const logStore = new LogStoreInstance(
            instanceName,
            database.store<InstanceLogEntry>("logs", {
                legacyFile: paths.legacyLogsFile,
                sequence: (record) => record.seq,
                timestamp: (record) => record.at
            })
        );
        const history = new AuditToolCallHistory(
            instanceName,
            database.toolCallStore({
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
            { source: "cli", workspace: "/projects/alpha" },
            "2026-07-07T00:00:01.000Z",
            "running",
            { taskId: "task-1", todoItemId: "implement" },
            { input: patch }
        );

        await history.started("call-2", "bash_run", "{\"command\":\"ls\"}", { source: "cli" }, "2026-07-07T00:00:02.000Z");
        assert.deepEqual(
            (await history.read({ status: "running" })).map((record) => ({
                callId: record.callId,
                workspace: record.workspace,
            })),
            [
                { callId: "call-1", workspace: "/projects/alpha" },
                { callId: "call-2", workspace: undefined },
            ],
        );

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
        assert.equal(completed.workspace, "/projects/alpha");
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

function createV1AuditDatabase(filePath: string, record: InstanceLogEntry): void {
    const require = createRequire(import.meta.url);
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
        const message = warning instanceof Error ? warning.message : warning;
        const type = typeof args[0] === "string"
            ? args[0]
            : typeof args[0] === "object" && args[0] !== null && "type" in args[0]
              ? String((args[0] as { type?: unknown }).type)
              : undefined;
        if (type === "ExperimentalWarning" && message.includes("SQLite")) return;
        Reflect.apply(originalEmitWarning, process, [warning, ...args]);
    }) as typeof process.emitWarning;
    try {
        const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
        const database = new DatabaseSync(filePath);
        const payload = JSON.stringify(record);
        database.exec(`
            CREATE TABLE audit_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL,
                payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
                payload TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 1;
        `);
        database.prepare(
            "INSERT INTO audit_records(collection, occurred_at_ms, payload_bytes, payload) VALUES (?, ?, ?, ?)"
        ).run("logs", Date.parse(record.at), Buffer.byteLength(payload, "utf8"), payload);
        database.close();
    } finally {
        process.emitWarning = originalEmitWarning;
    }
}

function readStoredAuditRow(filePath: string): { bodyCodec: string | null; payload: string } {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        return database.prepare(
            "SELECT payload, body_codec AS bodyCodec FROM audit_records WHERE collection = 'logs' ORDER BY id DESC LIMIT 1"
        ).get() as { bodyCodec: string | null; payload: string };
    } finally {
        database.close();
    }
}
