import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    controlErrorCodes,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import {
    readArtifactShareInput,
    readArtifactTransferStartInput,
    readDefaultInstance,
    readShareId,
    readTransferId,
} from "../../../src/artifact/route/Input.ts";
import {
    readMcpApprovalDecision,
    readMcpApprovalId,
} from "../../../src/server/auth/Input.ts";
import {
    readProcessSubscriptionFromSeq,
} from "../../../../core/src/instance/Route.ts";
import { readTodoSubscriptionFromSeq } from "../../../../core/src/task/todo/Route.ts";
import {
    readToolCall,
    readToolCallQuery,
    limitToolCallResponse,
} from "../../../../shared/src/execution/toolcall/RouteInput.ts";

test("artifact route inputs preserve the two supported source forms", () => {
    assert.deepEqual(
        readArtifactShareInput({
            expiresInSeconds: 300,
            handle: "artifact:stdout:1",
            instance: "source-one",
        }),
        {
            expiresInSeconds: 300,
            handle: "artifact:stdout:1",
            instance: "source-one",
        },
    );
    assert.deepEqual(
        readArtifactShareInput({
            path: "./result.bin",
            workspace: "/workspace",
        }),
        {
            path: "./result.bin",
            workspace: "/workspace",
        },
    );

    assert.deepEqual(
        readArtifactTransferStartInput({
            handle: "artifact:stdout:1",
            overwrite: true,
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin",
            targetWorkspace: "/tmp",
        }),
        {
            handle: "artifact:stdout:1",
            operation: "start",
            overwrite: true,
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin",
            targetWorkspace: "/tmp",
        },
    );
    assert.deepEqual(
        readArtifactTransferStartInput({
            instance: "source-one",
            sourcePath: "./result.bin",
            sourceWorkspace: "/source",
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin",
            targetWorkspace: "/tmp",
        }),
        {
            instance: "source-one",
            operation: "start",
            sourcePath: "./result.bin",
            sourceWorkspace: "/source",
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin",
            targetWorkspace: "/tmp",
        },
    );
});

test("artifact route inputs reject ambiguous, missing, and malformed fields", () => {
    const invalidValues: Array<() => unknown> = [
        () => readArtifactShareInput(),
        () => readArtifactShareInput({}),
        () => readArtifactShareInput({ handle: "one", path: "./two" }),
        () => readArtifactShareInput({ expiresInSeconds: 0, handle: "one" }),
        () => readArtifactShareInput({ handle: "" }),
        () =>
            readArtifactTransferStartInput({
                sourcePath: "./source",
                sourceWorkspace: "/source",
                targetInstance: "target",
                targetPath: "/target",
                targetWorkspace: "/target",
                overwrite: "yes",
            } as never),
        () =>
            readArtifactTransferStartInput({
                handle: "one",
                sourcePath: "./source",
                sourceWorkspace: "/source",
                targetInstance: "target",
                targetPath: "/target",
                targetWorkspace: "/target",
            }),
        () =>
            readArtifactTransferStartInput({
                sourcePath: "./source",
                sourceWorkspace: "/source",
                targetInstance: "",
                targetPath: "/target",
                targetWorkspace: "/target",
            }),
    ];

    for (const action of invalidValues) {
        assertTargetInvalid(action);
    }
});

test("artifact identity readers apply default-instance precedence and strict ids", () => {
    assert.equal(
        readDefaultInstance({
            defaultInstance: "explicit",
            instance: "source",
        }),
        "explicit",
    );
    assert.equal(readDefaultInstance({ instance: "source" }), "source");
    assert.equal(readShareId({ shareId: "share-1" }), "share-1");
    assert.equal(readTransferId({ transferId: "transfer-1" }), "transfer-1");

    for (const action of [
        () => readDefaultInstance({}),
        () => readDefaultInstance([]),
        () => readShareId({ shareId: "" }),
        () => readTransferId({ transferId: 1 } as never),
    ]) {
        assertTargetInvalid(action);
    }
});

test("MCP route inputs accept only their closed decision and identity contracts", () => {
    assert.equal(readMcpApprovalId({ approvalId: "approval-1" }), "approval-1");
    assert.equal(readMcpApprovalDecision({ decision: "approve" }), "approve");
    assert.equal(readMcpApprovalDecision({ decision: "deny" }), "deny");

    for (const action of [
        () => readMcpApprovalId({ approvalId: "" }),
        () => readMcpApprovalDecision({ decision: "allow" }),
    ]) {
        assertTargetInvalid(action);
    }
});

test("process route strictly validates subscription cursors", () => {
    for (const cursor of [0, 1, Number.MAX_SAFE_INTEGER]) {
        assert.equal(
            readProcessSubscriptionFromSeq({ fromSeq: cursor }),
            cursor,
        );
        assert.equal(readTodoSubscriptionFromSeq({ fromSeq: cursor }), cursor);
    }
    for (const cursor of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assertTargetInvalid(() =>
            readProcessSubscriptionFromSeq({ fromSeq: cursor }),
        );
        assertTargetInvalid(() =>
            readTodoSubscriptionFromSeq({ fromSeq: cursor }),
        );
    }
});

test("tool route inputs preserve control-host call defaults and filters", () => {
    assert.deepEqual(
        readToolCall({
            instance: "demo-local",
            toolName: "bash_run",
            workspace: "/workspace",
        }),
        {
            input: null,
            toolName: "bash_run",
            workspace: "/workspace",
        },
    );
    assert.deepEqual(
        readToolCall({
            instance: "demo-local",
            input: { command: "pwd" },
            toolName: "bash_run",
            workspace: "/workspace",
        }),
        {
            input: { command: "pwd" },
            toolName: "bash_run",
            workspace: "/workspace",
        },
    );
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
            status: "queued",
            toolName: "bash_run",
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
            status: "queued",
            toolName: "bash_run",
        },
    );
});

test("tool route inputs reject malformed filters", () => {
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
        () => readToolCallQuery({ status: "pendingApproval" as never }),
        () => readToolCallQuery({ toolName: 1 } as never),
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
    assert.deepEqual(
        newest.map((record) => record.callId),
        ["call-2", "call-3"],
    );
    assert.equal(
        Buffer.byteLength(JSON.stringify(newest), "utf8") <= 8 * 1024 * 1024,
        true,
    );

    const forward = limitToolCallResponse(records, {
        after: "call-0",
        limit: 200,
    });
    assert.deepEqual(
        forward.map((record) => record.callId),
        ["call-1", "call-2"],
    );
    assert.equal(
        Buffer.byteLength(JSON.stringify(forward), "utf8") <= 8 * 1024 * 1024,
        true,
    );

    assertTargetInvalid(() =>
        limitToolCallResponse(
            [{ ...records[0]!, output: { text: "x".repeat(9 * 1024 * 1024) } }],
            { callIds: ["call-1"], limit: 1 },
        ),
    );

    assert.deepEqual(
        limitToolCallResponse(records, {
            limit: 200,
            maxBytes: 4 * 1024 * 1024,
        }).map((record) => record.callId),
        ["call-3"],
    );
});

function assertTargetInvalid(action: () => unknown): void {
    assert.throws(action, (error: unknown) => {
        assert.equal(
            readErrorField(error, "code"),
            controlErrorCodes.invalidTarget,
        );
        assert.equal(readErrorField(error, "retryable"), false);
        return true;
    });
}

function readErrorField(error: unknown, field: string): unknown {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    return (error as Record<string, unknown>)[field];
}
