import assert from "node:assert/strict";
import test from "node:test";

import { createError, type JsonValue, type PrefixRouteContext, type WorkspacePath } from "@portable-devshell/shared";

import { createToolRouteModule } from "../../src/instance/tool/ToolRouteModule.ts";

function routeContext(connectionId: string): PrefixRouteContext {
    return {
        connectionId,
        peer: "tui",
        requestId: "req-1"
    } as unknown as PrefixRouteContext;
}

function callHandler(callTool: (toolName: string, input: JsonValue) => Promise<JsonValue>) {
    const module = createToolRouteModule({
        worker: {
            async callTool(toolName: string, input: JsonValue) {
                return callTool(toolName, input);
            },
            async decideApproval() {
                throw new Error("unused");
            },
            async getApproval() {
                throw new Error("unused");
            },
            async listApprovals() {
                throw new Error("unused");
            },
            async readToolCalls() {
                throw new Error("unused");
            },
            workspacePath: "/workspace" as WorkspacePath
        }
    });
    const operation = module.operations.find((entry) => entry.name === "call");
    if (operation === undefined) throw new Error("tool.call operation is missing");
    return operation.handle;
}

test("control tool route appends the worker result hint", async () => {
    const handle = callHandler(async () => ({
        exitCode: 7,
        stderr: "boom",
        stdout: "",
        termination: "exited"
    }) as JsonValue);

    const result = await handle(
        { id: "1", name: "call", payload: { input: { command: "pwd" }, toolName: "bash_run" } },
        routeContext("conn-1")
    ) as Record<string, JsonValue>;

    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, "boom");
    assert.equal("result" in result, false);
    assert.ok(Array.isArray(result.comment));
    assert.match(String(result.comment[0]), /^\[bash\.nonZeroExit\] /u);
    assert.match(String(result.comment[0]), /code 7/i);
    assert.match(String(result.comment[0]), /inspect output/i);
});

test("control tool route turns a thrown error into a structured hint instead of copying the message", async () => {
    const handle = callHandler(async () => {
        throw createError({ code: "file.revisionMismatch", message: "stale revision", retryable: true });
    });

    const result = await handle(
        { id: "1", name: "call", payload: { input: {}, toolName: "file_edit" } },
        routeContext("conn-2")
    ) as Record<string, JsonValue>;

    assert.equal(result.result, null);
    assert.deepEqual(result.error, { code: "file.revisionMismatch", message: "stale revision", retryable: true });
    assert.ok(Array.isArray(result.comment));
    assert.match(String(result.comment[0]), /^\[file\.revisionMismatch\] /u);
    assert.match(String(result.comment[0]), /read the latest content/i);
    assert.match(String(result.comment[0]), /regenerate the operation/i);
});
