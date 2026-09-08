import assert from "node:assert/strict";
import test from "node:test";

import { createError, type JsonValue, type PrefixRouteContext } from "@portable-devshell/shared";

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
            async listPendingApprovals() {
                throw new Error("unused");
            },
            listTools() { return []; },
            async prepareWorkspace(workspace: string) { return { workspace } as never; },
            async readToolCalls() {
                throw new Error("unused");
            },
            async releaseToolSession() {}
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
        { id: "1", name: "call", payload: { input: { command: "pwd" }, toolName: "bash_run", workspace: "/workspace" } },
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
        { id: "1", name: "call", payload: { input: {}, toolName: "file_edit", workspace: "/workspace" } },
        routeContext("conn-2")
    ) as Record<string, JsonValue>;

    assert.equal(result.result, null);
    assert.deepEqual(result.error, { code: "file.revisionMismatch", message: "stale revision", retryable: true });
    assert.ok(Array.isArray(result.comment));
    assert.match(String(result.comment[0]), /^\[file\.revisionMismatch\] /u);
    assert.match(String(result.comment[0]), /read the latest content/i);
    assert.match(String(result.comment[0]), /regenerate the operation/i);
});

test("control tool stream forwards progress before completing the unchanged final result", async () => {
    const emitted: Array<{ name: string; payload?: JsonValue }> = [];
    let completed: JsonValue | undefined;
    let workerContext: Record<string, unknown> | undefined;
    const module = createToolRouteModule({
        worker: {
            async callTool(
                _toolName: string,
                _input: JsonValue,
                context: Record<string, unknown>,
                _signal?: AbortSignal,
                _transformResult?: unknown,
                _invocationInput?: JsonValue,
                onProgress?: (progress: JsonValue) => void
            ) {
                workerContext = context;
                onProgress?.({ stdout: "one" });
                onProgress?.({ stdout: "one\ntwo" });
                return { exitCode: 0, stdout: "one\ntwo", stderr: "", termination: "exited" };
            },
            async decideApproval() { throw new Error("unused"); },
            async getApproval() { throw new Error("unused"); },
            async listApprovals() { return []; },
            async listPendingApprovals() { return []; },
            listTools() { return []; },
            async prepareWorkspace(workspace: string) { return { workspace } as never; },
            async readToolCalls() { return []; },
            async releaseToolSession() {}
        } as never
    });
    const operation = module.operations.find((entry) => entry.name === "callStream");
    if (operation === undefined) throw new Error("tool.callStream operation is missing");
    const context = {
        ...routeContext("pi-stream"),
        async openStream() {
            return {
                id: "stream-1",
                async cancel() {},
                async complete(payload?: JsonValue) { completed = payload; },
                async emit(name: string, payload?: JsonValue) { emitted.push({ name, payload }); }
            };
        }
    } as unknown as PrefixRouteContext;

    assert.equal(await operation.handle({
        id: "stream-request",
        name: "callStream",
        payload: {
            input: { command: "printf one; printf two" },
            operationId: "pi-call-1",
            toolName: "bash_run",
            workspace: "/workspace"
        }
    }, context), undefined);

    assert.deepEqual(emitted, [
        { name: "progress", payload: { stdout: "one" } },
        { name: "progress", payload: { stdout: "one\ntwo" } }
    ]);
    assert.deepEqual(completed, { comment: [], exitCode: 0, stdout: "one\ntwo", stderr: "", termination: "exited" });
    assert.equal(workerContext?.operationId, "pi-call-1");
    assert.equal(workerContext?.requestId, "req-1");
});

test("control tool route serves pending approval reads without scanning approval history", async () => {
    const module = createToolRouteModule({
        worker: {
            async callTool() { throw new Error("unused"); },
            async decideApproval() { throw new Error("unused"); },
            async getApproval() { throw new Error("unused"); },
            async listApprovals() { throw new Error("approval history must not be read"); },
            async listPendingApprovals() { return [{ approvalId: "approval-pending" } as never]; },
            listTools() { return []; },
            async prepareWorkspace(workspace: string) { return { workspace } as never; },
            async readToolCalls() { throw new Error("unused"); },
            async releaseToolSession() {}
        }
    });
    const operation = module.operations.find((entry) => entry.name === "listApprovals");
    if (operation === undefined) throw new Error("tool.listApprovals operation is missing");

    const result = await operation.handle(
        { id: "1", name: "listApprovals", payload: { pendingOnly: true } },
        routeContext("conn-3")
    ) as Array<{ approvalId: string }>;

    assert.deepEqual(result, [{ approvalId: "approval-pending" }]);
});

test("control tool session exposes canonical workspace and releases the connection-owned session", async () => {
    const released: string[] = [];
    const module = createToolRouteModule({
        worker: {
            async callTool() { throw new Error("unused"); },
            async decideApproval() { throw new Error("unused"); },
            async getApproval() { throw new Error("unused"); },
            async listApprovals() { return []; },
            async listPendingApprovals() { return []; },
            listTools() {
                return [{
                    description: "Read file",
                    group: "file",
                    inputSchema: { type: "object" },
                    name: "file_read",
                    outputSchema: {},
                    requiredCapabilities: ["read"]
                }];
            },
            async prepareWorkspace(workspace: string) {
                assert.equal(workspace, "/requested");
                return { workspace: "/canonical" } as never;
            },
            async readToolCalls() { return []; },
            async releaseToolSession(sessionId: string) { released.push(sessionId); }
        }
    });
    const open = module.operations.find((entry) => entry.name === "openSession");
    const close = module.operations.find((entry) => entry.name === "closeSession");
    if (open === undefined || close === undefined) throw new Error("tool session operations are missing");

    assert.deepEqual(await open.handle(
        { id: "1", name: "openSession", payload: { workspace: "/requested" } },
        routeContext("pi-connection")
    ), {
        tools: [{
            description: "Read file",
            group: "file",
            inputSchema: { type: "object" },
            name: "file_read",
            outputSchema: {},
            requiredCapabilities: ["read"]
        }],
        workspace: "/canonical"
    });
    assert.deepEqual(await close.handle(
        { id: "2", name: "closeSession", payload: {} },
        routeContext("pi-connection")
    ), {});
    assert.deepEqual(released, ["pi-connection"]);
});
