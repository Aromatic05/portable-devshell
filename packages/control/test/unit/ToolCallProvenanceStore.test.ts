import assert from "node:assert/strict";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { asInstanceName, type ToolCallRecord } from "@portable-devshell/shared";

import { ToolCallProvenanceStore } from "../../src/control/tool/ToolCallProvenanceStore.ts";
import { createToolRouteModule } from "../../src/instance/tool/ToolRouteModule.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("tool call provenance persists in Control and decorates matching Worker audit records", async () => {
    const root = await createTestTempDirectory("tool-call-provenance");
    const filePath = join(root, "tool-call-provenance.jsonl");
    try {
        const store = new ToolCallProvenanceStore(filePath);
        await store.record({
            callId: "call-1",
            explanation: "The previous test isolated the failure to Workspace reconnect handling.",
            instance: "alpha",
            purpose: "Verify the reconnect fix"
        });

        const workerRecord: ToolCallRecord = {
            callId: "call-1",
            ctxId: "ctx-alpha",
            inputSummary: "{}",
            instance: asInstanceName("alpha"),
            requestId: "reused-request-id",
            source: "mcp",
            startedAt: "2026-09-04T00:00:00.000Z",
            status: "completed",
            toolName: "bash_run"
        };
        const otherCall = { ...workerRecord, callId: "call-2" };

        assert.deepEqual(await store.decorate("alpha", [workerRecord, otherCall]), [{
            ...workerRecord,
            explanation: "The previous test isolated the failure to Workspace reconnect handling.",
            purpose: "Verify the reconnect fix"
        }, otherCall]);
        assert.deepEqual(await store.decorate("beta", [workerRecord]), [workerRecord]);

        const reloaded = new ToolCallProvenanceStore(filePath);
        assert.deepEqual(await reloaded.decorate("alpha", [workerRecord]), [{
            ...workerRecord,
            explanation: "The previous test isolated the failure to Workspace reconnect handling.",
            purpose: "Verify the reconnect fix"
        }]);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("tool.listCalls merges Control provenance without changing Worker records", async () => {
    const root = await createTestTempDirectory("tool-call-provenance-route");
    try {
        const store = new ToolCallProvenanceStore(join(root, "tool-call-provenance.jsonl"));
        await store.record({ callId: "call-1", instance: "alpha", purpose: "Review the failed command" });
        const workerRecord: ToolCallRecord = {
            callId: "call-1",
            inputSummary: "{}",
            instance: asInstanceName("alpha"),
            source: "mcp",
            startedAt: "2026-09-04T00:00:00.000Z",
            status: "failed",
            toolName: "bash_run"
        };
        const module = createToolRouteModule({
            name: "alpha",
            worker: {
                async callTool() { throw new Error("unused"); },
                async decideApproval() { throw new Error("unused"); },
                async getApproval() { throw new Error("unused"); },
                async listApprovals() { return []; },
                async readToolCalls() { return [workerRecord]; }
            }
        } as never, store);
        const operation = module.operations.find((entry) => entry.name === "listCalls");
        if (operation === undefined) throw new Error("tool.listCalls operation is missing");
        const result = await operation.handle({ id: "1", name: "listCalls", payload: {} }, {} as never);
        assert.deepEqual(result, [{ ...workerRecord, purpose: "Review the failed command" }]);
        assert.equal(workerRecord.purpose, undefined);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("tool call provenance rotates hot JSONL into compressed cold archives and reloads it", async () => {
    const root = await createTestTempDirectory("tool-call-provenance-archive");
    const filePath = join(root, "tool-call-provenance.jsonl");
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    try {
        const store = new ToolCallProvenanceStore(filePath, {
            coldMaxBytes: 1024 * 1024,
            hotMaxBytes: 1,
            now: () => now,
            retentionDays: 7
        });
        await store.record({ callId: "call-cold", instance: "alpha", purpose: "Keep cold provenance" });

        assert.equal((await stat(filePath)).size, 0);
        const archives = (await readdir(`${filePath}.archive`)).filter((name) => name.endsWith(".jsonl.zst"));
        assert.equal(archives.length, 1);

        const workerRecord = toolCall("call-cold");
        assert.deepEqual(await store.decorate("alpha", [workerRecord]), [{
            ...workerRecord,
            purpose: "Keep cold provenance"
        }]);
        const reloaded = new ToolCallProvenanceStore(filePath, {
            coldMaxBytes: 1024 * 1024,
            hotMaxBytes: 1,
            now: () => now,
            retentionDays: 7
        });
        assert.deepEqual(await reloaded.decorate("alpha", [workerRecord]), [{
            ...workerRecord,
            purpose: "Keep cold provenance"
        }]);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("tool call provenance retention removes expired hot and cold records", async () => {
    const root = await createTestTempDirectory("tool-call-provenance-retention");
    const coldPath = join(root, "cold.jsonl");
    const hotPath = join(root, "hot.jsonl");
    let now = Date.parse("2026-09-01T00:00:00.000Z");
    try {
        const cold = new ToolCallProvenanceStore(coldPath, {
            coldMaxBytes: 1024 * 1024,
            hotMaxBytes: 1,
            now: () => now,
            retentionDays: 7
        });
        const hot = new ToolCallProvenanceStore(hotPath, {
            coldMaxBytes: 1024 * 1024,
            hotMaxBytes: 1024 * 1024,
            now: () => now,
            retentionDays: 7
        });
        await cold.record({ callId: "cold-old", instance: "alpha", purpose: "old cold" });
        await hot.record({ callId: "hot-old", instance: "alpha", purpose: "old hot" });
        now += 8 * 24 * 60 * 60 * 1000;

        assert.deepEqual(await cold.decorate("alpha", [toolCall("cold-old")]), [toolCall("cold-old")]);
        assert.deepEqual(await hot.decorate("alpha", [toolCall("hot-old")]), [toolCall("hot-old")]);

        const coldReloaded = new ToolCallProvenanceStore(coldPath, {
            coldMaxBytes: 1024 * 1024,
            hotMaxBytes: 1,
            now: () => now,
            retentionDays: 7
        });
        const hotReloaded = new ToolCallProvenanceStore(hotPath, {
            coldMaxBytes: 1024 * 1024,
            hotMaxBytes: 1024 * 1024,
            now: () => now,
            retentionDays: 7
        });
        assert.deepEqual(await coldReloaded.decorate("alpha", [toolCall("cold-old")]), [toolCall("cold-old")]);
        assert.deepEqual(await hotReloaded.decorate("alpha", [toolCall("hot-old")]), [toolCall("hot-old")]);
        assert.equal((await readdir(`${coldPath}.archive`)).filter((name) => name.endsWith(".jsonl.zst")).length, 0);
        assert.equal((await stat(hotPath)).size, 0);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("tool call provenance cold budget evicts oldest archives", async () => {
    const root = await createTestTempDirectory("tool-call-provenance-budget");
    const filePath = join(root, "tool-call-provenance.jsonl");
    let now = Date.parse("2026-09-04T00:00:00.000Z");
    try {
        const seed = new ToolCallProvenanceStore(filePath, {
            coldMaxBytes: 1024 * 1024,
            hotMaxBytes: 1,
            now: () => now,
            retentionDays: 7
        });
        await seed.record({ callId: "call-old", instance: "alpha", purpose: "old archive" });
        now += 1000;
        await seed.record({ callId: "call-new", instance: "alpha", purpose: "new archive" });
        const archiveDirectory = `${filePath}.archive`;
        const names = (await readdir(archiveDirectory)).filter((name) => name.endsWith(".jsonl.zst")).sort();
        assert.equal(names.length, 2);
        const newestBytes = (await stat(join(archiveDirectory, names[1]!))).size;

        const bounded = new ToolCallProvenanceStore(filePath, {
            coldMaxBytes: newestBytes,
            hotMaxBytes: 1,
            now: () => now,
            retentionDays: 7
        });
        assert.deepEqual(await bounded.decorate("alpha", [toolCall("call-old")]), [toolCall("call-old")]);
        assert.deepEqual(await bounded.decorate("alpha", [toolCall("call-new")]), [{
            ...toolCall("call-new"),
            purpose: "new archive"
        }]);
        assert.equal((await readdir(archiveDirectory)).filter((name) => name.endsWith(".jsonl.zst")).length, 1);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

function toolCall(callId: string): ToolCallRecord {
    return {
        callId,
        inputSummary: "{}",
        instance: asInstanceName("alpha"),
        source: "mcp",
        startedAt: "2026-09-04T00:00:00.000Z",
        status: "completed",
        toolName: "bash_run"
    };
}
