import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
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
