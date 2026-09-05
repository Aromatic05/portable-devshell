import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { AuditDatabase } from "../../src/audit/AuditDatabase.ts";
import { type InstanceLogEntry, LogStoreInstance } from "../../src/log/store/LogStoreInstance.ts";
import { WorkerInstanceToolLog } from "../../src/worker/instance/tool/WorkerInstanceToolLog.ts";

test("WorkerInstanceToolLog chunks large streams without changing their content", async () => {
    const appended: Array<{ message: string; stream: string }> = [];
    const events: Array<{ data: unknown; type: string }> = [];
    const log = new WorkerInstanceToolLog({
        async appendEvent(type, data) {
            events.push({ data, type });
        },
        logStore: {
            async append(stream: string, message: string) {
                appended.push({ message, stream });
                return {};
            },
        } as never,
    });
    const stdout = `${"A".repeat(256 * 1024 - 1)}😀${"B".repeat(512 * 1024)}`;

    await log.append(
        { stderr: "", stdout },
        { callId: "call-large-log", source: "mcp", toolName: "bash_run" },
    );

    assert.equal(appended.length, 4);
    assert.equal(appended.every((entry) => entry.stream === "stdout"), true);
    assert.equal(appended.map((entry) => entry.message).join(""), stdout);
    assert.equal(
        appended.every((entry) => Buffer.byteLength(entry.message, "utf8") <= 768 * 1024),
        true,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "log.appended");
    assert.equal(
        (events[0]?.data as { bytes?: number }).bytes,
        Buffer.byteLength(stdout, "utf8"),
    );
});

test("WorkerInstanceToolLog keeps bounded reads below one MiB of decoded stream data", async () => {
    const root = await createTestTempDirectory("chunked-tool-log-");
    try {
        const database = new AuditDatabase(join(root, "audit.sqlite3"), {
            maxBytes: 32 * 1024 * 1024,
            retentionDays: 7,
        });
        const durable = database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at,
        });
        const store = new LogStoreInstance(asInstanceName("alpha"), durable);
        const log = new WorkerInstanceToolLog({ appendEvent: async () => undefined, logStore: store });
        await log.append(
            { stderr: "", stdout: "A".repeat(2 * 1024 * 1024) },
            { callId: "call-bounded-log", source: "mcp", toolName: "bash_run" },
        );

        const bounded = await log.read({ fromSeq: 1, limit: 100, maxDecodedBytes: 1024 * 1024 });
        assert.equal(bounded.length, 4);
        assert.equal(bounded.map((entry) => entry.message).join("").length, 1024 * 1024);
        database.close();
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
