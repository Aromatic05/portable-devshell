import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes } from "@portable-devshell/shared";

import {
    readArtifactShareInput,
    readArtifactTransferStartInput,
    readDefaultInstance,
    readShareId,
    readTransferId
} from "../../dist/control/artifact/route/ArtifactRouteInput.js";
import {
    readMcpApprovalDecision,
    readMcpApprovalId
} from "../../dist/control/mcp/McpRouteInput.js";
import { readReverseInstanceName } from "../../dist/control/reverse/route/ReverseRouteInput.js";
import {
    limitRuntimeLogResponse,
    readRuntimeLogQuery,
    readRuntimeSubscriptionFromSeq,
    readRuntimeWorkspacePath
} from "../../dist/instance/runtime/RuntimeRouteInput.js";
import { readTodoSubscriptionFromSeq } from "../../dist/instance/todo/TodoRouteInput.js";
import {
    readToolApprovalDecision,
    readToolApprovalId,
    readToolCall,
    readToolCallQuery
} from "../../dist/instance/tool/ToolRouteInput.js";

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
    assert.deepEqual(readArtifactShareInput({ path: "./result.bin" }), {
        path: "./result.bin"
    });

    assert.deepEqual(
        readArtifactTransferStartInput({
            handle: "artifact:stdout:1",
            overwrite: true,
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin"
        }),
        {
            handle: "artifact:stdout:1",
            operation: "start",
            overwrite: true,
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin"
        }
    );
    assert.deepEqual(
        readArtifactTransferStartInput({
            instance: "source-one",
            sourcePath: "./result.bin",
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin"
        }),
        {
            instance: "source-one",
            operation: "start",
            sourcePath: "./result.bin",
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin"
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
            targetInstance: "target",
            targetPath: "/target",
            overwrite: "yes"
        } as never),
        () => readArtifactTransferStartInput({
            handle: "one",
            sourcePath: "./source",
            targetInstance: "target",
            targetPath: "/target"
        }),
        () => readArtifactTransferStartInput({
            sourcePath: "./source",
            targetInstance: "",
            targetPath: "/target"
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
    assert.equal(readRuntimeWorkspacePath(), undefined);
    assert.equal(readRuntimeWorkspacePath({ workspacePath: "" }), "");
    assert.equal(readRuntimeWorkspacePath({ workspacePath: "/workspace" }), "/workspace");
    assertTargetInvalid(() => readRuntimeWorkspacePath({ workspacePath: 1 } as never));

    assert.deepEqual(readRuntimeLogQuery(), { fromSeq: undefined, limit: 100 });
    assert.deepEqual(readRuntimeLogQuery({ fromSeq: 10, limit: 0 }), { fromSeq: 10, limit: 1 });
    assert.deepEqual(readRuntimeLogQuery({ fromSeq: 10, limit: 500 }), { fromSeq: 10, limit: 100 });
    assert.deepEqual(readRuntimeLogQuery({ fromSeq: 10, limit: 1.5 }), { fromSeq: 10, limit: 100 });

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
    assert.match(limited[1]?.message ?? "", /^\n\[log output truncated\]\n/u);
    assert.match(limited[1]?.message ?? "", /TAIL$/u);
    assert.equal(Buffer.byteLength(JSON.stringify(limited), "utf8") <= 1024 * 1024, true);
});

test("tool route inputs preserve call defaults, filters, and approval metadata", () => {
    assert.deepEqual(readToolCall({ toolName: "bash_run" }), {
        input: null,
        toolName: "bash_run"
    });
    assert.deepEqual(readToolCall({ input: { command: "pwd" }, toolName: "bash_run" }), {
        input: { command: "pwd" },
        toolName: "bash_run"
    });
    assert.deepEqual(
        readToolCallQuery({
            after: "2026-01-01",
            before: "2026-02-01",
            limit: 25,
            source: "mcp",
            status: "pendingApproval",
            toolName: "bash_run"
        }),
        {
            after: "2026-01-01",
            before: "2026-02-01",
            limit: 25,
            source: "mcp",
            status: "pendingApproval",
            toolName: "bash_run"
        }
    );
    assert.equal(readToolApprovalId({ approvalId: "approval-1" }, "tool.getApproval"), "approval-1");
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
        () => readToolCallQuery({ limit: "10" } as never),
        () => readToolCallQuery({ source: "web" }),
        () => readToolCallQuery({ status: "queued" }),
        () => readToolCallQuery({ toolName: 1 } as never),
        () => readToolApprovalId({}, "tool.getApproval"),
        () => readToolApprovalDecision({ decision: "allow" }),
        () => readToolApprovalDecision({ decision: "deny", reason: 1 } as never),
        () => readToolApprovalDecision({ decision: "deny", remember: "yes" } as never)
    ]) {
        assertTargetInvalid(action);
    }
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
