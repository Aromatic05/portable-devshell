import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import {
    STREAM_GAP_CODE,
    asInstanceName,
    type ToolCallRecord,
} from "@portable-devshell/shared";
import { AuditDatabase, AUDIT_DATABASE_SCHEMA_VERSION } from "../../src/audit/database/index.ts";
import { AuditEventStore } from "../../src/audit/event/index.ts";
import type { InstanceLogEntry } from "../../src/audit/Api.ts";
import { LogStoreInstance } from "../../src/audit/log/index.ts";
import { InstancePaths } from "../../src/instance/Paths.ts";
import { InstanceEventBuffer } from "../../src/instance/runtime/supervision/Event.ts";
import { ToolCallHistory } from "../../src/toolcall/execution/record/History.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const MIB = 1024 * 1024;

test("AuditDatabase appends and reads records", async () => {
    const root = await createTestTempDirectory("sqlite");

    try {
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-15T00:00:00.000Z"),
            retentionDays: 30,
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            timestamp: (record) => record.at,
        });
        await store.append({ at: "2026-07-15T00:00:00.000Z", value: "one" });
        await store.append({ at: "2026-07-15T00:00:01.000Z", value: "two" });

        assert.deepEqual(await store.readAll(), [
            { at: "2026-07-15T00:00:00.000Z", value: "one" },
            { at: "2026-07-15T00:00:01.000Z", value: "two" },
        ]);
        assert.deepEqual(await store.readTail?.(1), [
            { at: "2026-07-15T00:00:01.000Z", value: "two" },
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
            retentionDays: 30,
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            timestamp: (record) => record.at,
        });
        await assert.rejects(
            access(databaseFile),
            (error: unknown) =>
                (error as NodeJS.ErrnoException).code === "ENOENT",
        );
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
            retentionDays: 30,
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            timestamp: (record) => record.at,
        });
        await store.append({
            at: "2026-07-15T00:00:00.000Z",
            value: "wal-record",
        });

        assert.equal((await stat(`${databaseFile}-wal`)).size > 0, true);
        const stats = database.stats();
        const mainBytes = (await stat(databaseFile)).size;
        const walBytes = await stat(`${databaseFile}-wal`)
            .then((value) => value.size)
            .catch(() => 0);
        assert.equal(stats.fileBytes, mainBytes + walBytes);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase compresses large log messages and restores them transparently", async () => {
    const root = await createTestTempDirectory("sqlite-log-zstd");
    const instanceName = asInstanceName("sqlite-log-zstd");
    const message =
        "cargo: compiling portable-devshell dependency graph\n".repeat(2_048);

    try {
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-09-01T12:00:00.000Z"),
            retentionDays: 30,
        });
        const store = database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at,
        });
        const record: InstanceLogEntry = {
            at: "2026-09-01T12:00:00.000Z",
            callId: "call-zstd",
            instanceName,
            message,
            seq: 1,
            stream: "stdout",
            toolName: "bash_run",
        };

        await store.append(record);

        assert.deepEqual(await store.readAll(), [record]);
        assert.deepEqual(await store.readFromSeq?.(1, 1), [record]);
        assert.equal(
            database.stats().payloadBytes <
                Buffer.byteLength(message, "utf8") / 4,
            true,
        );
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
            retentionDays: 30,
        });
        const store = database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at,
        });
        const record: InstanceLogEntry = {
            at: "2026-09-01T12:00:00.000Z",
            instanceName,
            message,
            seq: 1,
            stream: "stdout",
        };

        await store.append(record);
        assert.deepEqual(await store.readAll(), [record]);
        database.close();

        const row = readStoredAuditRow(databaseFile);
        assert.equal(row.bodyCodec, "identity");
        assert.equal(row.payload.includes('"message"'), false);
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
            retentionDays: 30,
        });
        const store = database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at,
        });
        for (let seq = 1; seq <= 3; seq += 1) {
            await store.append({
                at: `2026-09-01T12:00:0${seq}.000Z`,
                instanceName,
                message,
                seq,
                stream: "stdout",
            });
        }

        assert.equal((await store.readFromSeq?.(1, 100, MIB))?.length, 2);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase rejects v1 SQLite rows without modifying the historical database", async () => {
    const root = await createTestTempDirectory("sqlite-v1-upgrade");
    const databaseFile = join(root, "audit.sqlite3");
    const instanceName = asInstanceName("sqlite-v1-upgrade");
    const legacy: InstanceLogEntry = {
        at: "2026-09-01T11:00:00.000Z",
        instanceName,
        message: "historical inline stdout\n",
        seq: 1,
        stream: "stdout",
    };

    try {
        createV1AuditDatabase(databaseFile, legacy);
        const database = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-09-01T12:00:00.000Z"),
            retentionDays: 30,
        });
        const store = database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at,
        });
        assert.throws(
            () => store.readAll(),
            /schema version 1 is unsupported; expected 3/u,
        );
        assert.equal(readAuditUserVersion(databaseFile), 1);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase rejects a newer schema without modifying it", async () => {
    const root = await createTestTempDirectory("sqlite-future-schema");
    const databaseFile = join(root, "audit.sqlite3");

    try {
        createFutureAuditDatabase(
            databaseFile,
            AUDIT_DATABASE_SCHEMA_VERSION + 1,
        );
        const before = readRawAuditSchema(databaseFile);
        const database = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            retentionDays: 30,
        });
        const store = database.store<{ at: string }>("events", {
            timestamp: (record) => record.at,
        });

        assert.throws(() => store.readAll(), (error: unknown) => {
            assert.match(
                String((error as Error).message),
                /newer than the supported version/u,
            );
            assert.match(
                String((error as Error).message),
                /Upgrade portable-devshell/u,
            );
            assert.match(
                String((error as Error).message),
                /database was not modified/iu,
            );
            return true;
        });
        assert.deepEqual(readRawAuditSchema(databaseFile), before);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase does not backfill unsupported v1 databases", async () => {
    const root = await createTestTempDirectory("sqlite-deferred-accounting");
    const databaseFile = join(root, "audit.sqlite3");
    const instanceName = asInstanceName("sqlite-deferred-accounting");
    const legacy: InstanceLogEntry = {
        at: "2026-09-01T11:00:00.000Z",
        instanceName,
        message: "existing history",
        seq: 1,
        stream: "stdout",
    };

    try {
        createV1AuditDatabase(databaseFile, legacy);
        const database = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-09-01T12:00:00.000Z"),
            retentionDays: 30,
        });
        const store = database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at,
        });

        assert.throws(
            () => store.readAll(),
            /schema version 1 is unsupported; expected 3/u,
        );
        assert.equal(readAuditUserVersion(databaseFile), 1);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase append does not run retention or file maintenance on the request path", async () => {
    const root = await createTestTempDirectory("sqlite-deferred-maintenance");
    const databaseFile = join(root, "audit.sqlite3");
    const now = Date.parse("2026-09-01T12:00:00.000Z");

    try {
        const database = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => now,
            retentionDays: 7,
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            timestamp: (record) => record.at,
        });

        await store.append({
            at: "2026-08-01T00:00:00.000Z",
            value: "expired",
        });
        await store.append({
            at: "2026-09-01T12:00:00.000Z",
            value: "current",
        });
        assert.equal(readAuditRecordCount(databaseFile), 2);
        assert.deepEqual(
            (await store.readAll()).map((record) => record.value),
            ["current"],
        );

        database.cleanup();
        assert.equal(readAuditRecordCount(databaseFile), 1);
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("StateStore supports namespaced durable put, get, upsert, list and delete", async () => {
    const root = await createTestTempDirectory("sqlite-state");
    const file = join(root, "audit.sqlite3");
    const options = { maxBytes: 16 * MIB, retentionDays: 30 };
    const database = new AuditDatabase(file, options);
    try {
        assert.throws(
            () => database.stateStore(""),
            /State namespace must be a non-empty string/u,
        );
        const store = database.stateStore<{ value: string }>("settings");
        const other = database.stateStore<{ value: string }>("other");
        await assert.rejects(
            store.put("", { value: "invalid" }),
            /State key must be a non-empty string/u,
        );
        await assert.rejects(
            database.stateStore<undefined>("invalid").put("item", undefined),
            /not JSON-serializable/u,
        );
        assert.equal(await store.get("missing"), undefined);
        await store.put("b", { value: "old" });
        await store.put("a", { value: "first" });
        await store.put("b", { value: "latest" });
        await other.put("a", { value: "isolated" });
        assert.deepEqual(await store.get("b"), { value: "latest" });
        assert.deepEqual(await store.list(), [
            { value: "first" },
            { value: "latest" },
        ]);
        await store.delete("a");
        await store.delete("missing");
        assert.equal(await store.get("a"), undefined);
        assert.deepEqual(await other.list(), [{ value: "isolated" }]);
        assert.equal(database.stats().payloadBytes, 0);
        database.close();
        const reopened = new AuditDatabase(file, options);
        try {
            assert.deepEqual(await reopened.stateStore("settings").list(), [
                { value: "latest" },
            ]);
            assert.deepEqual(await reopened.stateStore("other").get("a"), {
                value: "isolated",
            });
        } finally {
            reopened.close();
        }
        await assert.rejects(store.get("b"), /closed/u);
        await assert.rejects(store.put("b", { value: "closed" }), /closed/u);
        await assert.rejects(store.list(), /closed/u);
        await assert.rejects(store.delete("b"), /closed/u);
    } finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("StateStore survives audit retention cleanup and max-record trimming", async () => {
    const root = await createTestTempDirectory("sqlite-state-retention");
    const file = join(root, "audit.sqlite3");
    const database = new AuditDatabase(file, {
        maxBytes: 16 * MIB,
        now: () => Date.parse("2026-07-15T00:00:00.000Z"),
        retentionDays: 1,
    });
    try {
        const store = database.stateStore<{ at: string; value: string }>(
            "current",
        );
        const current = { at: "2020-01-01T00:00:00.000Z", value: "durable" };
        await store.put("item", current);
        const audit = database.store<typeof current>("events", {
            timestamp: (record) => record.at,
            maxRecords: 1,
        });
        await audit.append({ ...current, value: "trimmed" });
        await audit.append({ ...current, value: "expired" });
        assert.equal(readAuditRecordCount(file), 1);
        database.cleanup();
        assert.equal(readAuditRecordCount(file), 0);
        assert.deepEqual(await store.get("item"), current);
        assert.equal(database.stats().payloadBytes, 0);
    } finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("StateStore preserves state when file pressure cannot meet maxBytes", async () => {
    const root = await createTestTempDirectory("sqlite-state-pressure");
    const database = new AuditDatabase(join(root, "audit.sqlite3"), {
        maxBytes: MIB,
        retentionDays: 30,
    });
    try {
        const store = database.stateStore<string>("large");
        const value = "x".repeat(2 * MIB);
        await store.put("item", value);
        const audit = database.store<{ at: number; value: string }>("events", {
            timestamp: (record) => record.at,
        });
        await audit.append({ at: Date.now(), value: "audit".repeat(MIB) });
        assert.throws(() => database.cleanup(), /cannot fit within maxBytes/u);
        assert.equal(await store.get("item"), value);
        assert.deepEqual(await audit.readAll(), []);
    } finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("StateStore stays isolated from legacy JSONL files", async () => {
    const root = await createTestTempDirectory("sqlite-state-migration");
    const file = join(root, "audit.sqlite3");
    const legacyFile = join(root, "state.jsonl");
    const options = { maxBytes: 16 * MIB, retentionDays: 1 };
    const legacyContents = '{"id":"legacy","value":"old"}\n';
    await writeFile(
        legacyFile,
        legacyContents,
    );
    const database = new AuditDatabase(file, options);
    try {
        const store = database.stateStore<{ id: string; value: string }>("current");
        await store.put("current", { id: "current", value: "new" });
        assert.deepEqual(await store.list(), [
            { id: "current", value: "new" },
        ]);
        assert.equal(await store.get("legacy"), undefined);
        assert.equal(await readFile(legacyFile, "utf8"), legacyContents);
    } finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("StateStore does not interpret malformed legacy JSONL as state", async () => {
    const root = await createTestTempDirectory("sqlite-state-rollback");
    const file = join(root, "audit.sqlite3");
    const legacyFile = join(root, "state.jsonl");
    const database = new AuditDatabase(file, {
        maxBytes: 16 * MIB,
        retentionDays: 30,
    });
    try {
        const store = database.stateStore<{ id: string }>("current");
        await store.put("keep", { id: "keep" });
        await writeFile(legacyFile, '{"id":"first"}\n{"id":null}\n');
        const reloaded = database.stateStore<{ id: string }>("current");
        assert.deepEqual(await reloaded.list(), [{ id: "keep" }]);
        assert.deepEqual(await store.list(), [{ id: "keep" }]);
        assert.equal(
            await readFile(legacyFile, "utf8"),
            '{"id":"first"}\n{"id":null}\n',
        );
    } finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});

function renameLegacyAuditCollection(file: string): void {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(file);
    try {
        database.exec(
            "UPDATE audit_records SET collection = 'legacy-state' WHERE collection = 'events'",
        );
    } finally {
        database.close();
    }
}

test("ToolCallHistory requests only the unfiltered limited history window", async () => {
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
    let requestedLimit = 0;
    const history = new ToolCallHistory(instanceName, {
        async append() {},
        hasCall() { return false; },
        readFailureSummary() { return { count: 0 }; },
        readQuery(query = {}) {
            requestedLimit = query.limit ?? 0;
            return [record];
        },
    });

    assert.deepEqual(await history.read({ limit: 200 }), [record]);
    assert.equal(requestedLimit, 200);
});

test("ToolCallHistory persists post-execution failure metadata", async () => {
    const instanceName = asInstanceName("publication-failure-history");
    const records: ToolCallRecord[] = [];
    const history = new ToolCallHistory(instanceName, {
        async append(record) {
            records.push(record);
        },
        hasCall() { return false; },
        readFailureSummary() { return { count: 0 }; },
        readQuery() {
            return records;
        },
    });

    await history.started(
        "call-publication-failure",
        "bash_run",
        "{}",
        { source: "mcp" },
        "2026-09-22T00:00:00.000Z",
    );
    await history.failed(
        "call-publication-failure",
        "core.providerFailed",
        "2026-09-22T00:00:01.000Z",
        {
            executionCompleted: true,
            failureStage: "outboundHook",
        },
    );

    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "failed");
    assert.equal(records[0]?.executionCompleted, true);
    assert.equal(records[0]?.failureStage, "outboundHook");
});

test("ToolCallHistory keeps active calls when bounded history is already full", async () => {
    const instanceName = asInstanceName("active-first-history");
    const persisted = ["old", "new"].map((callId, index): ToolCallRecord => ({
        callId,
        inputSummary: "{}",
        instance: instanceName,
        source: "mcp",
        startedAt: `2026-09-01T00:00:0${index}.000Z`,
        status: "completed",
        toolName: "bash_run",
    }));
    const history = new ToolCallHistory(instanceName, {
        async append() {},
        hasCall() { return false; },
        readFailureSummary() { return { count: 0 }; },
        readQuery(query = {}) {
            assert.equal(query.limit, 2);
            return persisted;
        },
    });
    await history.started(
        "active",
        "bash_run",
        "{}",
        { source: "mcp" },
        "2026-09-01T00:00:02.000Z",
    );

    assert.deepEqual(
        (await history.read({ limit: 2 })).map((record) => record.callId),
        ["new", "active"],
    );
});

test("ToolCallHistory pushes filtered limited history into storage", async () => {
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
        workspace: "/repo/filtered",
    };
    let storageQuery: unknown;
    const history = new ToolCallHistory(instanceName, {
        async append() {},
        hasCall() { return false; },
        readFailureSummary() { return { count: 0 }; },
        readQuery(query) {
            storageQuery = query;
            return [record];
        },
    });

    assert.deepEqual(
        await history.read({
            ctxId: "ctx-filtered",
            limit: 64,
            workspace: "/repo/filtered",
        }),
        [record],
    );
    assert.deepEqual(storageQuery, {
        ctxId: "ctx-filtered",
        limit: 64,
        workspace: "/repo/filtered",
    });
});

test("ToolCallHistory keeps cursor pagination bounded while merging active calls", async () => {
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
    let readQueryCalled = false;
    const history = new ToolCallHistory(instanceName, {
        async append() {},
        hasCall(callId) {
            return callId === "persisted-1";
        },
        readFailureSummary() { return { count: 0 }; },
        readQuery(query) {
            readQueryCalled = true;
            assert.deepEqual(query, {
                after: "persisted-1",
                ctxId: "ctx-cursor",
                limit: 2,
            });
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
        (
            await history.read({
                after: "persisted-1",
                ctxId: "ctx-cursor",
                limit: 2,
            })
        ).map((record) => record.callId),
        ["persisted-2", "active-1"],
    );
    assert.equal(readQueryCalled, true);
});

test("ToolCallHistory can exclude the detached wait owner from Context activity", async () => {
    const instanceName = asInstanceName("active-context-exclusion");
    const history = new ToolCallHistory(instanceName, {
        async append() {},
        hasCall() { return false; },
        readFailureSummary() { return { count: 0 }; },
        readQuery() {
            return [];
        },
    });
    await history.started(
        "call-wait-owner",
        "tmux_run",
        "{}",
        { ctxId: "ctx-active", source: "mcp" },
        "2026-09-01T00:00:00.000Z",
    );
    assert.equal(history.hasActiveForContext("ctx-active"), true);
    assert.equal(
        history.hasActiveForContext("ctx-active", "call-wait-owner"),
        false,
    );

    await history.started(
        "call-concurrent",
        "file_read",
        "{}",
        { ctxId: "ctx-active", source: "mcp" },
        "2026-09-01T00:00:01.000Z",
    );
    assert.equal(
        history.hasActiveForContext("ctx-active", "call-wait-owner"),
        true,
    );
});

test("AuditDatabase queries bounded tool-call history and failure summaries without materializing all records", async () => {
    const root = await createTestTempDirectory("sqlite-tool-query");
    const instanceName = asInstanceName("sqlite-tool-query");
    const now = Date.parse("2026-09-01T12:00:00.000Z");

    try {
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 16 * MIB,
            now: () => now,
            retentionDays: 30,
        });
        const store = database.toolCallStore({
            timestamp: (record) => record.completedAt ?? record.startedAt,
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
                input: { command: "echo secret" },
                inputSummary: "{}",
                instance: instanceName,
                output: { text: "x".repeat(4_096) },
                source: "mcp",
                startedAt: "2026-09-01T09:59:00.000Z",
                status: "completed",
                toolName: "bash_run",
                workspace: "/repo/b",
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
                workspace: "/repo/a",
            },
            {
                callId: "extension-call",
                completedAt: "2026-09-01T11:30:00.000Z",
                ctxId: "ctx-extension",
                inputSummary: "{}",
                instance: instanceName,
                source: "extension",
                startedAt: "2026-09-01T11:29:00.000Z",
                status: "completed",
                toolName: "file_read",
            },
        ];
        for (const record of records) await store.append(record);

        assert.deepEqual(
            (await store.readQuery({ ctxId: "ctx-a", limit: 1 })).map(
                (record) => record.callId,
            ),
            ["ctx-a-latest"],
        );
        assert.deepEqual(
            (
                await store.readQuery({
                    source: "mcp",
                    status: "completed",
                    toolName: "bash_run",
                })
            ).map((record) => record.callId),
            ["ctx-b"],
        );
        assert.deepEqual(
            (await store.readQuery({ source: "extension" })).map(
                (record) => record.callId,
            ),
            ["extension-call"],
        );
        assert.deepEqual(
            (await store.readQuery({ workspace: "/repo/b" })).map(
                (record) => record.callId,
            ),
            ["ctx-b"],
        );
        const compact = await store.readQuery({
            includeInput: false,
            includeOutput: false,
            limit: 10,
            maxBytes: 1024,
        });
        assert.equal(
            compact.some((record) => record.callId === "ctx-b"),
            true,
        );
        assert.equal(
            compact.find((record) => record.callId === "ctx-b")?.input,
            undefined,
        );
        assert.equal(
            compact.find((record) => record.callId === "ctx-b")?.output,
            undefined,
        );
        assert.equal(
            Buffer.byteLength(JSON.stringify(compact), "utf8") <= 1024,
            true,
        );
        assert.deepEqual(
            await store.readFailureSummary(now - 24 * 60 * 60 * 1_000, now),
            { count: 2, latest: records[2] },
        );
        assert.deepEqual(
            (await store.readQuery({ after: "ctx-a-old", limit: 1 })).map(
                (record) => record.callId,
            ),
            ["ctx-b"],
        );
        assert.deepEqual(
            (await store.readQuery({ before: "ctx-a-latest", limit: 1 })).map(
                (record) => record.callId,
            ),
            ["ctx-b"],
        );
        assert.deepEqual(
            (
                await store.readQuery({
                    after: "ctx-a-old",
                    before: "ctx-a-latest",
                    status: "completed",
                })
            ).map((record) => record.callId),
            ["ctx-b"],
        );
        assert.deepEqual(
            await store.readQuery({ after: "missing", limit: 1 }),
            [],
        );
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase ignores legacy JSONL files", async () => {
    const root = await createTestTempDirectory("sqlite-migrate");
    const legacyFile = join(root, "logs.jsonl");
    const databaseFile = join(root, "audit.sqlite3");

    try {
        await writeFile(
            legacyFile,
            `${JSON.stringify({ at: "2026-07-15T00:00:00.000Z", value: "legacy" })}\n`,
            "utf8",
        );
        const database = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-15T00:00:00.000Z"),
            retentionDays: 30,
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            timestamp: (record) => record.at,
        });

        await access(legacyFile);
        assert.deepEqual(store.readAll(), []);
        await store.append({ at: "2026-07-15T00:00:01.000Z", value: "current" });
        assert.deepEqual(store.readAll(), [
            { at: "2026-07-15T00:00:01.000Z", value: "current" },
        ]);
        database.close();

        const reopened = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-15T00:00:00.000Z"),
            retentionDays: 30,
        });
        const reopenedStore = reopened.store<{ at: string; value: string }>(
            "logs",
            {
                timestamp: (record) => record.at,
            },
        );
        assert.deepEqual(await reopenedStore.readAll(), [
            { at: "2026-07-15T00:00:01.000Z", value: "current" },
        ]);
        await access(legacyFile);
        reopened.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("AuditDatabase filters expired rows on read and evicts oldest rows above maxBytes", async () => {
    const root = await createTestTempDirectory("sqlite-cleanup");
    let now = Date.parse("2026-07-15T00:00:00.000Z");

    try {
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 16 * MIB,
            now: () => now,
            retentionDays: 7,
        });
        const store = database.store<{ at: string; value: string }>("logs", {
            timestamp: (record) => record.at,
        });
        await store.append({
            at: "2026-07-01T00:00:00.000Z",
            value: "expired",
        });
        await store.append({
            at: "2026-07-15T00:00:00.000Z",
            value: "current",
        });
        assert.deepEqual(
            (await store.readAll()).map((record) => record.value),
            ["current"],
        );

        const large = "x".repeat(6 * MIB);
        await store.append({
            at: "2026-07-15T00:00:01.000Z",
            value: `first-${large}`,
        });
        await store.append({
            at: "2026-07-15T00:00:02.000Z",
            value: `second-${large}`,
        });
        await store.append({
            at: "2026-07-15T00:00:03.000Z",
            value: `third-${large}`,
        });
        const retained = await store.readAll();
        assert.equal(
            retained.some((record) => record.value.startsWith("first-")),
            false,
        );
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
    const instanceName = asInstanceName("task-5-events");
    const buffer = new InstanceEventBuffer(instanceName, 2);

    await buffer.append({
        at: "2026-07-07T00:00:00.000Z",
        type: "instance.started",
    });
    await buffer.append({
        at: "2026-07-07T00:00:01.000Z",
        type: "instance.statusChanged",
    });
    await buffer.append({
        at: "2026-07-07T00:00:02.000Z",
        type: "toolCall.completed",
    });

    const replay = buffer.readFrom(2);
    assert.equal(replay.kind, "events");
    assert.deepEqual(
        replay.events.map((event) => event.seq),
        [2, 3],
    );
    assert.equal(replay.lastSeq, 3);

    const gap = buffer.readFrom(1);
    assert.equal(gap.kind, "gap");
    assert.equal(gap.code, STREAM_GAP_CODE);
    assert.equal(gap.nextSeq, 2);
});

test("AuditEventStore trims the collection to the configured replay window", async () => {
    const root = await createTestTempDirectory("events-existing-window");
    const databaseFile = join(root, "audit.sqlite3");
    const instanceName = asInstanceName("events-existing-window");

    try {
        const original = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-07T00:00:10.000Z"),
            retentionDays: 30,
        });
        const originalStore = new AuditEventStore(original, 5);
        for (let seq = 1; seq <= 5; seq += 1) {
            await originalStore.append({
                at: `2026-07-07T00:00:0${seq}.000Z`,
                instanceName,
                seq,
                type: "instance.statusChanged",
            });
        }
        original.close();

        const reopened = new AuditDatabase(databaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-07T00:00:10.000Z"),
            retentionDays: 30,
        });
        const boundedStore = new AuditEventStore(reopened, 2);
        await boundedStore.append({
            at: "2026-07-07T00:00:06.000Z",
            instanceName,
            seq: 6,
            type: "instance.statusChanged",
        });

        assert.deepEqual(
            boundedStore.readTail(10).map((event) => event.seq),
            [5, 6],
        );
        assert.equal(boundedStore.readHighWater(), 6);
        reopened.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("InstanceEventBuffer assigns sequences in append order", async () => {
    const instanceName = asInstanceName("event-persist-failure");
    const buffer = new InstanceEventBuffer(instanceName, 8);
    const appended = await Promise.all([
        buffer.append({
            at: "2026-08-13T00:00:00.000Z",
            type: "instance.started",
        }),
        buffer.append({
            at: "2026-08-13T00:00:01.000Z",
            type: "instance.statusChanged",
        }),
    ]);

    assert.deepEqual(appended.map((event) => event.seq), [1, 2]);
    assert.equal(buffer.lastSeq, 2);
});

test("InstanceEventBuffer retains only its bounded in-memory tail", async () => {
    const instanceName = asInstanceName("event-tail-restore");
    const buffer = new InstanceEventBuffer(instanceName, 4);
    for (let index = 0; index < 20; index += 1) {
        await buffer.append({
            at: `2026-08-13T00:00:${String(index).padStart(2, "0")}.000Z`,
            type: "instance.statusChanged",
        });
    }
    const appended = await buffer.append({
        at: "2026-08-13T00:01:00.000Z",
        type: "instance.statusChanged",
    });

    assert.equal(appended.seq, 21);
    const replay = buffer.readFrom(18);
    assert.equal(replay.kind, "events");
    assert.deepEqual(
        replay.events.map((event) => event.seq),
        [18, 19, 20, 21],
    );
});

test("LogStoreInstance pushes fromSeq and limit into sequenced storage", async () => {
    const instanceName = asInstanceName("log-range-read");
    const entries: InstanceLogEntry[] = Array.from(
        { length: 5 },
        (_, index) => ({
            at: `2026-08-13T00:00:0${index}.000Z`,
            instanceName,
            message: `line-${index + 1}`,
            seq: index + 1,
            stream: "stdout",
        }),
    );
    let range: [number, number | undefined] | undefined;
    const store = {
        async append() {},
        async readAll() {
            throw new Error("unbounded log read should not run");
        },
        async readFromSeq(fromSeq: number, limit?: number) {
            range = [fromSeq, limit];
            return entries
                .filter((entry) => entry.seq >= fromSeq)
                .slice(0, limit);
        },
        async readHighWater() {
            return 5;
        },
        async readTail() {
            return entries.slice(-1);
        },
    } as never;
    const logs = new LogStoreInstance(instanceName, store);

    assert.deepEqual(
        (await logs.read({ fromSeq: 3, limit: 2 })).map((entry) => entry.seq),
        [3, 4],
    );
    assert.deepEqual(range, [3, 2]);
});

test("LogStoreInstance reads the newest bounded window when no sequence cursor is supplied", async () => {
    const instanceName = asInstanceName("log-tail-read");
    const entries: InstanceLogEntry[] = Array.from(
        { length: 5 },
        (_, index) => ({
            at: `2026-08-13T00:00:0${index}.000Z`,
            instanceName,
            message: `line-${index + 1}`,
            seq: index + 1,
            stream: "stdout",
        }),
    );
    let tail: [number, number | undefined] | undefined;
    const store = {
        async append() {},
        readAll() {
            throw new Error("unbounded log read should not run");
        },
        readHighWater() {
            return 5;
        },
        readTail(limit: number, maxDecodedBytes?: number) {
            tail = [limit, maxDecodedBytes];
            return entries.slice(-limit);
        },
    } as never;
    const logs = new LogStoreInstance(instanceName, store);

    assert.deepEqual(
        (await logs.read({ limit: 2, maxDecodedBytes: 1234 })).map(
            (entry) => entry.seq,
        ),
        [4, 5],
    );
    assert.deepEqual(tail, [2, 1234]);
});

test("LogStoreInstance serializes concurrent appends and commits sequence only after persistence", async () => {
    const instanceName = asInstanceName("log-append-order");
    const persisted: InstanceLogEntry[] = [];
    let failFirst = true;
    const store = {
        async append(record: InstanceLogEntry) {
            if (failFirst) {
                failFirst = false;
                throw new Error("audit unavailable");
            }
            persisted.push(record);
        },
        readAll() {
            return [];
        },
        readHighWater() {
            return 0;
        },
        readTail() {
            return [];
        },
    } as never;
    const logs = new LogStoreInstance(instanceName, store);

    const failed = logs.append("stdout", "failed", "2026-08-13T00:00:00.000Z");
    const second = logs.append("stdout", "second", "2026-08-13T00:00:01.000Z");
    const third = logs.append("stderr", "third", "2026-08-13T00:00:02.000Z");

    await assert.rejects(failed, /audit unavailable/u);
    assert.deepEqual(
        (await Promise.all([second, third])).map((entry) => entry.seq),
        [1, 2],
    );
    assert.deepEqual(
        persisted.map((entry) => entry.seq),
        [1, 2],
    );
});

test("LogStoreInstance and ToolCallHistory write and query per-instance records", async () => {
    const root = await createTestTempDirectory("storage");
    const instanceName = asInstanceName("task-5-storage");

    try {
        const paths = new InstancePaths(instanceName, root);
        const database = new AuditDatabase(paths.auditDatabaseFile, {
            maxBytes: 16 * MIB,
            now: () => Date.parse("2026-07-07T00:00:10.000Z"),
            retentionDays: 30,
        });
        const logStore = new LogStoreInstance(
            instanceName,
            database.store<InstanceLogEntry>("logs", {
                sequence: (record) => record.seq,
                timestamp: (record) => record.at,
            }),
        );
        const history = new ToolCallHistory(
            instanceName,
            database.toolCallStore({
                timestamp: (record) => record.completedAt ?? record.startedAt,
            }),
        );

        const wideLogContext = {
            callId: "call-1",
            requestId: "request-1",
            ctxId: "context-1",
            inputSummary: "must-not-persist",
            source: "mcp",
            toolName: "bash_run",
            workspace: "/duplicate/workspace",
        } as const;
        const logEntry = await logStore.append(
            "stdout",
            "hello",
            "2026-07-07T00:00:00.000Z",
            wideLogContext,
        );
        assert.equal(logEntry.seq, 1);
        assert.equal(logEntry.callId, "call-1");
        assert.equal(logEntry.requestId, "request-1");
        assert.equal(logEntry.ctxId, "context-1");
        assert.equal(logEntry.source, "mcp");
        assert.equal(logEntry.toolName, "bash_run");
        assert.equal("inputSummary" in logEntry, false);
        assert.equal("workspace" in logEntry, false);
        assert.deepEqual(await logStore.read({ fromSeq: 1 }), [logEntry]);

        const patch =
            "*** Begin Patch\n*** Update File: src/example.ts\n" +
            "+line\n".repeat(120) +
            "*** End Patch";
        await history.started(
            "call-1",
            "bash_run",
            '{"command":"pwd"}',
            { source: "cli", workspace: "/projects/alpha" },
            "2026-07-07T00:00:01.000Z",
            "running",
            { input: patch },
        );

        await history.started(
            "call-2",
            "bash_run",
            '{"command":"ls"}',
            { source: "cli" },
            "2026-07-07T00:00:02.000Z",
        );
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
            {
                exitCode: 0,
                output: { stdout: "ok" },
                stderrBytes: 0,
                stdoutBytes: 2,
                termination: "exited",
            },
        );
        assert.equal(completed.status, "completed");
        assert.equal(completed.exitCode, 0);
        assert.equal(completed.stdoutBytes, 2);
        assert.equal(completed.termination, "exited");
        assert.equal(completed.inputSummary, '{"command":"pwd"}');
        assert.equal(
            (completed.input as { input?: unknown } | undefined)?.input,
            patch,
        );
        assert.deepEqual(completed.output, { stdout: "ok" });
        assert.equal(completed.source, "cli");
        assert.equal(completed.workspace, "/projects/alpha");

        const completedSecond = await history.completed(
            "call-2",
            "2026-07-07T00:00:03.500Z",
            {
                exitCode: 0,
                stderrBytes: 0,
                stdoutBytes: 3,
                termination: "exited",
            },
        );
        assert.equal(completedSecond.status, "completed");
        await history.started(
            "call-3",
            "bash_run",
            '{"command":"false"}',
            { requestId: "req-3", source: "mcp" },
            "2026-07-07T00:00:04.000Z",
        );

        const failed = await history.failed(
            "call-3",
            "worker.command_failed",
            "2026-07-07T00:00:05.000Z",
            {
                exitCode: 1,
                output: { stderr: "fail" },
                stderrBytes: 4,
                stdoutBytes: 0,
                termination: "exited",
            },
        );
        assert.equal(failed.status, "failed");
        assert.equal(failed.error, "worker.command_failed");
        assert.equal(failed.requestId, "req-3");
        assert.equal(failed.source, "mcp");
        assert.equal(failed.stderrBytes, 4);
        assert.deepEqual(failed.output, { stderr: "fail" });

        const records = await history.read();
        assert.deepEqual(
            records.map((record) => record.callId),
            ["call-1", "call-2", "call-3"],
        );
        assert.deepEqual(
            (await history.read({ limit: 1 })).map((record) => record.callId),
            ["call-3"],
        );
        assert.deepEqual(
            (await history.read({ after: "call-1" })).map(
                (record) => record.callId,
            ),
            ["call-2", "call-3"],
        );
        assert.deepEqual(
            (await history.read({ before: "call-3", limit: 1 })).map(
                (record) => record.callId,
            ),
            ["call-2"],
        );
        assert.deepEqual(
            (await history.read({ source: "mcp" })).map(
                (record) => record.callId,
            ),
            ["call-3"],
        );
        assert.deepEqual(
            (await history.read({ status: "completed" })).map(
                (record) => record.callId,
            ),
            ["call-1", "call-2"],
        );
        assert.deepEqual(
            (await history.read({ toolName: "bash_run" })).map(
                (record) => record.callId,
            ),
            ["call-1", "call-2", "call-3"],
        );
        database.close();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function createV1AuditDatabase(
    filePath: string,
    record: InstanceLogEntry,
): void {
    const require = createRequire(import.meta.url);
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
        const message = warning instanceof Error ? warning.message : warning;
        const type =
            typeof args[0] === "string"
                ? args[0]
                : typeof args[0] === "object" &&
                    args[0] !== null &&
                    "type" in args[0]
                  ? String((args[0] as { type?: unknown }).type)
                  : undefined;
        if (type === "ExperimentalWarning" && message.includes("SQLite"))
            return;
        Reflect.apply(originalEmitWarning, process, [warning, ...args]);
    }) as typeof process.emitWarning;
    try {
        const { DatabaseSync } =
            require("node:sqlite") as typeof import("node:sqlite");
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
        database
            .prepare(
                "INSERT INTO audit_records(collection, occurred_at_ms, payload_bytes, payload) VALUES (?, ?, ?, ?)",
            )
            .run(
                "logs",
                Date.parse(record.at),
                Buffer.byteLength(payload, "utf8"),
                payload,
            );
        database.close();
    } finally {
        process.emitWarning = originalEmitWarning;
    }
}

function createFutureAuditDatabase(filePath: string, version: number): void {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        database.exec(`
            CREATE TABLE future_sentinel (value TEXT NOT NULL) STRICT;
            INSERT INTO future_sentinel(value) VALUES ('preserve-me');
            PRAGMA user_version = ${version};
        `);
    } finally {
        database.close();
    }
}

function readAuditUserVersion(filePath: string): number {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        return readAuditUserVersionFromDatabase(database);
    } finally {
        database.close();
    }
}

function readRawAuditSchema(filePath: string): {
    sentinel: string;
    tables: string[];
    userVersion: number;
} {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        const tables = (
            database
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
                )
                .all() as Array<{ name: string }>
        ).map((row) => row.name);
        const sentinel = (
            database.prepare("SELECT value FROM future_sentinel").get() as {
                value: string;
            }
        ).value;
        return {
            sentinel,
            tables,
            userVersion: readAuditUserVersionFromDatabase(database),
        };
    } finally {
        database.close();
    }
}

function readAuditUserVersionFromDatabase(
    database: import("node:sqlite").DatabaseSync,
): number {
    return Number(
        Object.values(
            database.prepare("PRAGMA user_version").get() as Record<
                string,
                number
            >,
        )[0] ?? 0,
    );
}

function readStoredAuditRow(filePath: string): {
    bodyCodec: string | null;
    payload: string;
} {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        return database
            .prepare(
                "SELECT payload, body_codec AS bodyCodec FROM audit_records WHERE collection = 'logs' ORDER BY id DESC LIMIT 1",
            )
            .get() as { bodyCodec: string | null; payload: string };
    } finally {
        database.close();
    }
}

function readAuditRecordCount(filePath: string): number {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath);
    try {
        const row = database
            .prepare("SELECT COUNT(*) AS count FROM audit_records")
            .get() as { count: number };
        return row.count;
    } finally {
        database.close();
    }
}
