import assert from "node:assert/strict";
import test from "node:test";

import { attachToolCallErrorPayload } from "@portable-devshell/core";
import {
    createRemoteError,
    type JsonValue,
    type ToolCallContext,
    type ControlPortContext,
} from "@portable-devshell/shared";

import { createToolRouteModule } from "../../../../src/instance/execution/tool/Route.ts";

function routeContext(connectionId: string): ControlPortContext {
    return {
        afterReply() {},
        connectionId,
        host: "demo",
        peer: "tui",
        requestId: "req-1",
        signal: new AbortController().signal,
    };
}

function callHandler(
    callTool: (toolName: string, input: JsonValue) => Promise<JsonValue>,
    comments: readonly string[] = [],
) {
    const module = createToolRouteModule(
        { name: "demo", worker: {} as never },
        undefined,
        {
            async call(_instance, toolName, input) {
                const result = await callTool(toolName, input).catch(
                    (error) => {
                        throw attachToolCallErrorPayload(error, {
                            comment: [...comments],
                        });
                    },
                );
                return {
                    ...(result as Record<string, JsonValue>),
                    comment: [...comments],
                };
            },
        },
    );
    const operation = module.operations.find((entry) => entry.name === "call");
    if (operation === undefined)
        throw new Error("tool.call operation is missing");
    return operation.handle;
}

test("control tool route appends the worker result hint", async () => {
    const handle = callHandler(
        async () =>
            ({
                exitCode: 7,
                stderr: "boom",
                stdout: "",
                termination: "exited",
            }) as JsonValue,
        ["[bash.nonZeroExit] Exited with code 7; inspect output."],
    );

    const result = (await handle(
        {
            id: "1",
            name: "call",
            payload: {
                input: { command: "pwd" },
                toolName: "bash_run",
                workspace: "/workspace",
            },
        },
        routeContext("conn-1"),
    )) as Record<string, JsonValue>;

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
        throw createRemoteError({
            code: "file.revisionMismatch",
            message: "stale revision",
            retryable: true,
        });
    }, [
        "[file.revisionMismatch] Read the latest content and regenerate the operation before retrying.",
    ]);

    const result = (await handle(
        {
            id: "1",
            name: "call",
            payload: {
                input: {},
                toolName: "file_edit",
                workspace: "/workspace",
            },
        },
        routeContext("conn-2"),
    )) as Record<string, JsonValue>;

    assert.equal(result.result, null);
    assert.deepEqual(result.error, {
        code: "file.revisionMismatch",
        message: "stale revision",
        retryable: true,
    });
    assert.ok(Array.isArray(result.comment));
    assert.match(String(result.comment[0]), /^\[file\.revisionMismatch\] /u);
    assert.match(String(result.comment[0]), /read the latest content/i);
    assert.match(String(result.comment[0]), /regenerate the operation/i);
});

test("control tool stream forwards progress before completing the unchanged final result", async () => {
    const emitted: Array<{ name: string; payload?: JsonValue }> = [];
    let completed: JsonValue | undefined;
    let workerContext: ToolCallContext | undefined;
    let workerRecording: "caller" | "host" | undefined;
    const module = createToolRouteModule(
        { name: "demo", worker: {} as never },
        undefined,
        {
            async call(
                instance,
                _toolName,
                _input,
                context,
                signal,
                _transformResult,
                _invocationInput,
                onProgress,
                recording,
            ) {
                assert.equal(instance, "demo");
                assert.equal(signal, streamContext.signal);
                workerContext = context;
                workerRecording = recording;
                onProgress?.({ stdout: "one" });
                onProgress?.({ stdout: "one\ntwo" });
                return {
                    exitCode: 0,
                    stdout: "one\ntwo",
                    stderr: "",
                    termination: "exited",
                };
            },
        },
    );
    const operation = module.streams?.find(
        (entry) => entry.name === "callStream",
    );
    if (operation === undefined)
        throw new Error("tool.callStream stream is missing");
    const streamContext = routeContext("pi-stream");
    const stream = {
        async close(payload?: JsonValue) {
            completed = payload;
        },
        async send(message: { name: string; payload?: JsonValue }) {
            emitted.push(message);
        },
    };

    assert.equal(
        await operation.handle(
            stream as never,
            {
                id: "stream-request",
                name: "callStream",
                payload: {
                    input: { command: "printf one; printf two" },
                    operationId: "pi-call-1",
                    recording: "caller",
                    toolName: "bash_run",
                    workspace: "/workspace",
                },
            },
            streamContext,
        ),
        undefined,
    );

    assert.deepEqual(emitted, [
        { name: "progress", payload: { stdout: "one" } },
        { name: "progress", payload: { stdout: "one\ntwo" } },
    ]);
    assert.deepEqual(completed, {
        exitCode: 0,
        stdout: "one\ntwo",
        stderr: "",
        termination: "exited",
    });
    assert.equal(workerContext?.operationId, "pi-call-1");
    assert.equal(workerContext?.requestId, "req-1");
    assert.equal(workerRecording, "caller");
});

test("control tool route does not expose approval operations", () => {
    const module = createToolRouteModule({ worker: {} as never });
    assert.deepEqual(
        module.operations.map((operation) => operation.name),
        ["openSession", "closeSession", "listCalls"],
    );
    assert.equal(module.streams, undefined);
});

test("control tool session exposes canonical workspace and releases the connection-owned session", async () => {
    const released: string[] = [];
    const module = createToolRouteModule({
        worker: {
            listTools() {
                return [
                    {
                        description: "Read file",
                        group: "file",
                        inputSchema: { type: "object" },
                        name: "file_read",
                        outputSchema: {},
                        requiredCapabilities: ["read"],
                    },
                ];
            },
            async prepareWorkspace(workspace: string) {
                assert.equal(workspace, "/requested");
                return { workspace: "/canonical" } as never;
            },
            async readToolCalls() {
                return [];
            },
            async releaseToolSession(sessionId: string) {
                released.push(sessionId);
            },
        },
    });
    const open = module.operations.find(
        (entry) => entry.name === "openSession",
    );
    const close = module.operations.find(
        (entry) => entry.name === "closeSession",
    );
    if (open === undefined || close === undefined)
        throw new Error("tool session operations are missing");

    assert.deepEqual(
        await open.handle(
            {
                id: "1",
                name: "openSession",
                payload: { workspace: "/requested" },
            },
            routeContext("pi-connection"),
        ),
        {
            tools: [
                {
                    description: "Read file",
                    group: "file",
                    inputSchema: { type: "object" },
                    name: "file_read",
                    outputSchema: {},
                    requiredCapabilities: ["read"],
                },
            ],
            workspace: "/canonical",
        },
    );
    assert.deepEqual(
        await close.handle(
            { id: "2", name: "closeSession", payload: {} },
            routeContext("pi-connection"),
        ),
        {},
    );
    assert.deepEqual(released, ["pi-connection"]);
});
