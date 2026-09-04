import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, errorCodes, type ToolCallRecord } from "@portable-devshell/shared";

import {
    readArtifactShareInput,
    readArtifactTransferStartInput,
    readDefaultInstance,
    readShareId,
    readTransferId
} from "../../src/control/artifact/route/ArtifactRouteInput.ts";
import {
    readMcpApprovalDecision,
    readMcpApprovalId
} from "../../src/control/mcp/McpRouteInput.ts";
import { readReverseInstanceName } from "../../src/control/reverse/route/ReverseRouteInput.ts";
import {
    limitRuntimeLogResponse,
    readRuntimeLogQuery,
    readRuntimeSubscriptionFromSeq
} from "../../src/instance/runtime/RuntimeRouteInput.ts";
import { readTodoSubscriptionFromSeq } from "../../src/instance/todo/TodoRouteInput.ts";
import {
    limitToolCallResponse,
    readToolApprovalDecision,
    readToolApprovalId,
    readToolApprovalListOptions,
    readToolCall,
    readToolCallQuery
} from "../../src/instance/tool/ToolRouteInput.ts";

test("artifact route inputs preserve the two supported source forms", () => {
    assert.deepEqual(
        readArtifactShareInput({
            expiresInSeconds: 300,
            handle: "artifact:stdout:1",
            instance: "source-one"
        }),
        {
            expiresInSeconds: 300,
            handle: "artifact:stdout:1",
            instance: "source-one"
        }
    );
    assert.deepEqual(readArtifactShareInput({ path: "./result.bin", workspace: "/workspace" }), {
        path: "./result.bin",
        workspace: "/workspace"
    });

    assert.deepEqual(
        readArtifactTransferStartInput({
            handle: "artifact:stdout:1",
            overwrite: true,
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin",
            targetWorkspace: "/tmp"
        }),
        {
            handle: "artifact:stdout:1",
            operation: "start",
            overwrite: true,
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin",
            targetWorkspace: "/tmp"
        }
    );
    assert.deepEqual(
        readArtifactTransferStartInput({
            instance: "source-one",
            sourcePath: "./result.bin",
            sourceWorkspace: "/source",
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin",
            targetWorkspace: "/tmp"
        }),
        {
            instance: "source-one",
            operation: "start",
            sourcePath: "./result.bin",
            sourceWorkspace: "/source",
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin",
            targetWorkspace: "/tmp"
        }
    );
});

test("artifact route inputs reject ambiguous, missing, and malformed fields", () => {
    const invalidValues: Array<() => unknown> = [
        () => readArtifactShareInput(),
        () => readArtifactShareInput({}),
        () => readArtifactShareInput({ handle: "one", path: "./two" }),
        () => readArtifactShareInput({ expiresInSeconds: 0, handle: "one" }),
        () => readArtifactShareInput({ handle: "" }),
        () => readArtifactTransferStartInput({
            sourcePath: "./source",
            sourceWorkspace: "/source",
            targetInstance: "target",
            targetPath: "/target",
            targetWorkspace: "/target",
            overwrite: "yes"
        } as never),
        () => readArtifactTransferStartInput({
            handle: "one",
            sourcePath: "./source",
            sourceWorkspace: "/source",
            targetInstance: "target",
            targetPath: "/target",
            targetWorkspace: "/target"
        }),
        () => readArtifactTransferStartInput({
            sourcePath: "./source",
            sourceWorkspace: "/source",
            targetInstance: "",
            targetPath: "/target",
            targetWorkspace: "/target"
        })
    ];

    for (const action of invalidValues) {
        assertTargetInvalid(action);
    }
});

test("artifact identity readers apply default-instance precedence and strict ids", () => {
    assert.equal(readDefaultInstance({ defaultInstance: "explicit", instance: "source" }), "explicit");
    assert.equal(readDefaultInstance({ instance: "source" }), "source");
    assert.equal(readShareId({ shareId: "share-1" }), "share-1");
    assert.equal(readTransferId({ transferId: "transfer-1" }), "transfer-1");

    for (const action of [
        () => readDefaultInstance({}),
        () => readDefaultInstance([]),
        () => readShareId({ shareId: "" }),
        () => readTransferId({ transferId: 1 } as never)
    ]) {
        assertTargetInvalid(action);
    }
});

test("MCP and reverse route inputs accept only their closed decision and identity contracts", () => {
    assert.equal(readMcpApprovalId({ approvalId: "approval-1" }), "approval-1");
    assert.equal(readMcpApprovalDecision({ decision: "approve" }), "approve");
    assert.equal(readMcpApprovalDecision({ decision: "deny" }), "deny");
    assert.equal(readReverseInstanceName({ instance: "reverse-one" }), "reverse-one");

    for (const action of [
        () => readMcpApprovalId({ approvalId: "" }),
        () => readMcpApprovalDecision({ decision: "allow" }),
        () => readReverseInstanceName({ instance: 1 } as never)
    ]) {
        assertTargetInvalid(action);
    }
});

test("runtime route inputs clamp log queries and strictly validate subscription cursors", () => {
    assert.deepEqual(readRuntimeLogQuery(), { fromSeq: undefined, limit: 100, maxDecodedBytes: 1024 * 1024 });
    assert.deepEqual(readRuntimeLogQuery({ fromSeq: 10, limit: 0 }), { fromSeq: 10, limit: 1, maxDecodedBytes: 1024 * 1024 });
    assert.deepEqual(readRuntimeLogQuery({ fromSeq: 10, limit: 500 }), { fromSeq: 10, limit: 100, maxDecodedBytes: 1024 * 1024 });
    assert.deepEqual(readRuntimeLogQuery({ fromSeq: 10, limit: 1.5 }), { fromSeq: 10, limit: 100, maxDecodedBytes: 1024 * 1024 });
    assert.deepEqual(readRuntimeLogQuery({ maxDecodedBytes: 256 * 1024 }), { fromSeq: undefined, limit: 100, maxDecodedBytes: 256 * 1024 });
    assert.deepEqual(readRuntimeLogQuery({ maxDecodedBytes: 2 * 1024 * 1024 }), { fromSeq: undefined, limit: 100, maxDecodedBytes: 1024 * 1024 });

    for (const cursor of [0, 1, Number.MAX_SAFE_INTEGER]) {
        assert.equal(readRuntimeSubscriptionFromSeq({ fromSeq: cursor }), cursor);
        assert.equal(readTodoSubscriptionFromSeq({ fromSeq: cursor }), cursor);
    }
    for (const cursor of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assertTargetInvalid(() => readRuntimeSubscriptionFromSeq({ fromSeq: cursor }));
        assertTargetInvalid(() => readTodoSubscriptionFromSeq({ fromSeq: cursor }));
    }
});

test("runtime log response limiting stays within one MiB and retains the newest fitting suffix", () => {
    const logs = [
        { message: "first", seq: 1 },
        { message: `${"前".repeat(600_000)}TAIL`, seq: 2 },
        { message: "must-not-be-returned", seq: 3 }
    ];
    const limited = limitRuntimeLogResponse(logs);

    assert.equal(limited.length, 2);
    assert.equal(limited[0]?.message, "first");
    assert.match(limited[1]?.message ?? "", /TAIL$/u);
    assert.equal(limited[1]?.message === logs[1]?.message, false);
    assert.equal(Buffer.byteLength(JSON.stringify(limited), "utf8") <= 1024 * 1024, true);
});

test("tool route inputs preserve call defaults, filters, and approval metadata", () => {
    assert.deepEqual(readToolCall({ toolName: "bash_run", workspace: "/workspace" }), {
        input: null,
        toolName: "bash_run",
        workspace: "/workspace"
    });
    assert.deepEqual(readToolCall({ input: { command: "pwd" }, toolName: "bash_run", workspace: "/workspace" }), {
        input: { command: "pwd" },
        toolName: "bash_run",
        workspace: "/workspace"
    });
    assert.deepEqual(readToolCallQuery(), { limit: 200 });
    assert.deepEqual(readToolCallQuery({ limit: 0 }), { limit: 1 });
    assert.deepEqual(readToolCallQuery({ limit: 50_000 }), { limit: 1_000 });
    assert.deepEqual(
        readToolCallQuery({
            after: "2026-01-01",
            before: "2026-02-01",
            callIds: ["call-1", "call-2"],
            ctxId: "ctx-1",
            includeInput: false,
            includeOutput: true,
            limit: 25,
            maxBytes: 4096,
            source: "mcp",
            status: "pendingApproval",
            toolName: "bash_run"
        }),
        {
            after: "2026-01-01",
            before: "2026-02-01",
            callIds: ["call-1", "call-2"],
            ctxId: "ctx-1",
            includeInput: false,
            includeOutput: true,
            limit: 25,
            maxBytes: 4096,
            source: "mcp",
            status: "pendingApproval",
            toolName: "bash_run"
        }
    );
    assert.equal(readToolApprovalId({ approvalId: "approval-1" }, "tool.getApproval"), "approval-1");
    assert.deepEqual(readToolApprovalListOptions(), { pendingOnly: false });
    assert.deepEqual(readToolApprovalListOptions({ pendingOnly: true }), { pendingOnly: true });
    assert.deepEqual(
        readToolApprovalDecision({
            decision: "approve",
            policyPatch: { mode: "allow" },
            reason: "reviewed",
            remember: true
        }),
        {
            decision: "approve",
            policyPatch: { mode: "allow" },
            reason: "reviewed",
            remember: true
        }
    );
});

test("tool route inputs reject malformed filters and approval decisions", () => {
    for (const action of [
        () => readToolCall({ toolName: "" }),
        () => readToolCallQuery({ after: 1 } as never),
        () => readToolCallQuery({ before: 1 } as never),
        () => readToolCallQuery({ callIds: ["call-1", null] } as never),
        () => readToolCallQuery({ callIds: [""] }),
        () => readToolCallQuery({ ctxId: 1 } as never),
        () => readToolCallQuery({ includeInput: "yes" } as never),
        () => readToolCallQuery({ includeOutput: "yes" } as never),
        () => readToolCallQuery({ limit: "10" } as never),
        () => readToolCallQuery({ limit: 1.5 }),
        () => readToolCallQuery({ maxBytes: "1024" } as never),
        () => readToolCallQuery({ maxBytes: 1.5 }),
        () => readToolCallQuery({ source: "web" }),
        () => readToolCallQuery({ status: "queued" }),
        () => readToolCallQuery({ toolName: 1 } as never),
        () => readToolApprovalId({}, "tool.getApproval"),
        () => readToolApprovalListOptions({ pendingOnly: "yes" } as never),
        () => readToolApprovalDecision({ decision: "allow" }),
        () => readToolApprovalDecision({ decision: "deny", reason: 1 } as never),
        () => readToolApprovalDecision({ decision: "deny", remember: "yes" } as never)
    ]) {
        assertTargetInvalid(action);
    }
});

test("tool call responses stay bounded while preserving pagination direction", () => {
    const records = [1, 2, 3].map((index): ToolCallRecord => ({
        callId: `call-${index}`,
        inputSummary: `call-${index}`,
        instance: asInstanceName("demo-local"),
        output: { text: "x".repeat(3 * 1024 * 1024) },
        source: "cli",
        startedAt: `2026-09-01T00:00:0${index}.000Z`,
        status: "completed",
        toolName: "bash_run",
    }));

    const newest = limitToolCallResponse(records, { limit: 200 });
    assert.deepEqual(newest.map((record) => record.callId), ["call-2", "call-3"]);
    assert.equal(Buffer.byteLength(JSON.stringify(newest), "utf8") <= 8 * 1024 * 1024, true);

    const forward = limitToolCallResponse(records, { after: "call-0", limit: 200 });
    assert.deepEqual(forward.map((record) => record.callId), ["call-1", "call-2"]);
    assert.equal(Buffer.byteLength(JSON.stringify(forward), "utf8") <= 8 * 1024 * 1024, true);

    assertTargetInvalid(() => limitToolCallResponse([
        { ...records[0]!, output: { text: "x".repeat(9 * 1024 * 1024) } }
    ], { callIds: ["call-1"], limit: 1 }));

    assert.deepEqual(
        limitToolCallResponse(records, { limit: 200, maxBytes: 4 * 1024 * 1024 }).map((record) => record.callId),
        ["call-3"],
    );
});

function assertTargetInvalid(action: () => unknown): void {
    assert.throws(action, (error: unknown) => {
        assert.equal(readErrorField(error, "code"), errorCodes.targetInvalid);
        assert.equal(readErrorField(error, "retryable"), false);
        return true;
    });
}

function readErrorField(error: unknown, field: string): unknown {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    return (error as Record<string, unknown>)[field];
}
