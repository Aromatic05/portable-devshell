import { asInstanceName } from "@portable-devshell/shared";
import { createToolCallRuntime } from "@portable-devshell/shared";
import type { ToolCallHookValue } from "@portable-devshell/shared";
import assert from "node:assert/strict";
import test from "node:test";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

import type {
    ContextTransport,
    JsonValue,
    ToolCallApi,
    ToolCallContext,
    ToolDefinition,
} from "@portable-devshell/shared";
import type { McpToolProvenanceRecorder } from "../../../../src/protocol/tool/Provenance.ts";
import { contextToolDefinitions } from "../../../../../control/src/context/tool/Definition.ts";
import {
    createTestMcpRuntimeState,
} from "../../../ContextRuntime.ts";
import { McpEndpoint } from "../../../../src/protocol/Endpoint.ts";
import { TestToolSource } from "../../../support/ToolSource.ts";
import {
    withMcpContextId,
    withMcpInstanceTarget,
} from "../../../../src/protocol/tool/Input.ts";

const bashTool: ToolDefinition = {
    requiredCapabilities: ["execute"],
    description: "Run a shell command.",
    group: "bash",
    inputSchema: {
        additionalProperties: false,
        properties: {
            command: { type: "string" },
        },
        required: ["command"],
        type: "object",
    },
    name: "bash_run",
    outputSchema: { type: "object" },
};

const fileReadTool: ToolDefinition = {
    requiredCapabilities: ["read"],
    description: "Read files.",
    group: "file",
    inputSchema: {
        additionalProperties: false,
        properties: { files: { type: "array" } },
        required: ["files"],
        type: "object",
    },
    name: "file_read",
    outputSchema: { type: "object" },
};

const context = { principal: "local", requestId: "request-1" } as const;
const contextState = createTestMcpRuntimeState();
const contextRegistry = contextState.contexts.registry;
await contextState.contexts.initialize();
test.after(async () => {
    contextState.toolCallRuntime.close();
    await contextState.contexts.close();
});
const activeWorkspace = await createTestTempDirectory("mcp-worker-domain");
const activeContext = await contextRegistry.create({
    environments: [
        {
            instance: "main-pc",
            workspace: activeWorkspace,
        },
    ],
    principal: "local",
});
const withContext = <T extends Record<string, unknown>>(
    input: T,
): T & { ctxId: string } => ({
    ...input,
    ctxId: activeContext.ctxId,
});

test("MCP does not expose instance attachment management tools", () => {
    const worker = createWorker();
    const endpoint = createManagedEndpoint(worker);
    const tools = endpoint.listTools();

    for (const name of [
        "instance_connect",
        "instance_list",
        "instance_status",
        "instance_create",
        "instance_stop",
    ]) {
        assert.equal(
            tools.some((tool) => tool.name === name),
            false,
            name,
        );
    }
    const remote = tools.find((tool) => tool.name === "environ_remote");
    assert.notEqual(remote, undefined);
    const remoteSchema = remote?.inputSchema as {
        anyOf?: unknown;
        oneOf?: unknown;
        properties?: Record<string, { enum?: unknown; type?: unknown }>;
        required?: string[];
        type?: unknown;
    };
    assert.equal(remoteSchema.type, "object");
    assert.equal(remoteSchema.anyOf, undefined);
    assert.equal(remoteSchema.oneOf, undefined);
    assert.equal(remoteSchema.properties?.command?.type, "string");
    assert.equal(remoteSchema.properties?.command?.enum, undefined);
    assert.deepEqual(remoteSchema.required, ["command"]);
    assert.equal(remoteSchema.properties?.ctxId, undefined);
    assert.equal(
        (
            tools.find((tool) => tool.name === "bash_run")?.inputSchema as {
                properties?: Record<string, unknown>;
            }
        ).properties?.instance,
        undefined,
    );
});

test("endpoint lists worker and Context tools without exposing instance management tools", () => {
    const endpoint = createManagedEndpoint();
    const tools = endpoint.listTools();

    assert.equal(
        (
            tools.find((tool) => tool.name === "bash_run")?.inputSchema as {
                properties?: Record<string, unknown>;
            }
        ).properties?.instance,
        undefined,
    );
    assert.equal(
        (
            tools.find((tool) => tool.name === "environ_info")?.inputSchema as {
                properties?: Record<string, unknown>;
            }
        ).properties?.instance,
        undefined,
    );
    for (const name of [
        "instance_connect",
        "instance_list",
        "instance_status",
        "instance_create",
        "instance_stop",
    ]) {
        assert.equal(
            tools.some((tool) => tool.name === name),
            false,
            name,
        );
    }
});

test("routing fields are injected into strict worker schema union branches", () => {
    const unionTool: ToolDefinition = {
        requiredCapabilities: ["execute"],
        description: "Union tool",
        group: "task",
        inputSchema: {
            $defs: {
                Create: {
                    additionalProperties: false,
                    properties: { command: { const: "create" }, cwd: { type: "string" } },
                    required: ["command"],
                    type: "object",
                },
                Close: {
                    additionalProperties: false,
                    properties: { command: { const: "close" }, task: { type: "string" } },
                    required: ["command", "task"],
                    type: "object",
                },
            },
            anyOf: [{ $ref: "#/$defs/Create" }, { $ref: "#/$defs/Close" }],
        },
        name: "task_manage",
        outputSchema: { type: "object" },
    };
    const schema = withMcpInstanceTarget(withMcpContextId(unionTool))
        .inputSchema as {
        $defs?: Record<
            string,
            {
                properties?: Record<string, unknown>;
                required?: string[];
            }
        >;
    };
    for (const branch of Object.values(schema.$defs ?? {})) {
        assert.notEqual(branch.properties?.ctxId, undefined);
        assert.notEqual(branch.properties?.instance, undefined);
        assert.equal(branch.required?.includes("ctxId"), true);
        assert.equal(branch.required?.includes("instance"), false);
    }
});

test("worker tools reject instance routing outside the single-instance endpoint schema", async () => {
    await assert.rejects(
        createManagedEndpoint(createWorker({ tools: [bashTool, fileReadTool] })).callTool(
            "bash_run",
            withContext({ command: "pwd", instance: "remote-server" }),
            context,
        ),
        { code: "control.invalidTarget" },
    );
});

test("worker tools missing from the endpoint catalog cannot be recovered from a remote instance", async () => {
    let remoteCalled = false;
    const tools = createToolCalls(async () => {
            remoteCalled = true;
            return { remote: true };
    });
    const endpoint = createManagedEndpoint(
        createWorker({ hasSchema: false, ready: false, tools: [] }),
        tools,
    );

    await assert.rejects(
        endpoint.callTool(
            "bash_run",
            withContext({ command: "pwd", instance: "remote-server" }),
            context,
        ),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                "core.toolSchemaUnavailable",
            );
            return true;
        },
    );
    assert.equal(remoteCalled, false);
});

test("truncated bash output remains readable without an artifact recovery tool", async () => {
    const endpoint = createManagedEndpoint(
        createWorker(),
        createToolCalls(async () => ({
            comment: ["[bash.outputTruncated] stdout output is incomplete."],
            exitCode: 0,
            stderr: "",
            stderrTruncated: false,
            stdout: "partial",
            stdoutArtifact: { handle: "artifact-1" },
            stdoutTruncated: true,
            termination: "exited",
        })),
    );

    const result = (await endpoint.callTool(
        "bash_run",
        withContext({ command: "produce-output" }),
        context,
    )) as { comment?: string[] };
    assert.deepEqual(result.comment, [
        "[bash.outputTruncated] stdout output is incomplete.",
    ]);
    assert.equal(
        endpoint.listTools().some((tool) => tool.name === "artifact_read"),
        false,
    );
});



test("MCP Extension operation uses final rewritten tool and Context without worker preparation", async () => {
    const h = await rewrittenEndpoint("ext_final", true);
    await h.endpoint.callTool(
        "ext_original",
        { ctxId: h.original.ctxId, purpose: "operation" },
        context,
    );
    assert.deepEqual(
        h.changes.find((change) => change[0] === "extension"),
        [
            "extension",
            "final",
            "ext_final",
            h.values[0]!.payload,
            h.values[0]!.context,
        ],
    );
    assert.equal(
        h.changes.some((change) => change[0] === "workspace"),
        false,
    );
    assert.deepEqual(h.provenance, [
        { callId: h.callIds[0], instance: "final", purpose: "operation" },
    ]);
    await h.close();
});

function createManagedEndpoint(
    worker = createWorker(),
    tools: ToolCallApi = createToolCalls(),
    options: {
        contextMode?: "explicit" | "openai-session";
        contextState?: ReturnType<typeof createTestMcpRuntimeState>;
        toolProvenance?: McpToolProvenanceRecorder;
        toolDefinitions?: readonly ToolDefinition[];
    } = {},
): McpEndpoint {
    const state = options.contextState ?? contextState;
    const toolSource = new TestToolSource();
    const workerTools = worker.listTools();
    const workerToolNames = new Set(workerTools.map(({ name }) => name));
    toolSource.register("main-pc", [
        ...workerTools,
        ...contextToolDefinitions(),
        ...(options.toolDefinitions ?? []).filter(
            ({ name }) => !workerToolNames.has(name),
        ),
    ]);
    return new McpEndpoint({
        context: state.contextTransport,
        contextMode: options.contextMode,
        instanceName: "main-pc",
        toolProvenance: options.toolProvenance,
        toolSource,
        tools,
    });
}

function createToolCalls(
    handle: (
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
    ) => Promise<JsonValue> | JsonValue = async (instance, toolName) => ({
        instance,
        toolName,
    }),
): ToolCallApi {
    return {
        async call(
            instance,
            toolName,
            input,
            callContext,
            _signal,
            transformResult,
            invocationInput,
        ) {
            const callId = "call-test";
            const value = {
                context: { ...callContext, instance: asInstanceName(instance) },
                kind: "call" as const,
                payload: input,
                toolName,
            };
            const preparedInput =
                (await invocationInput?.(input, callId, value)) ?? input;
            const result = await handle(
                instance,
                toolName,
                preparedInput,
                callContext,
            );
            return (await transformResult?.(result, callId)) ?? result;
        },
    };
}

function createWorker(options: {
    hasSchema?: boolean;
    ready?: boolean;
    tools?: ToolDefinition[];
} = {}) {
    return {
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async readAlerts() {
            return { advice: [] };
        },
        handshake: {
            homeDirectory: "/home/demo",
            instance: "main-pc",
            platform: {
                arch: "x86_64",
                distribution: { id: "arch", name: "Arch Linux", version: "rolling" },
                os: "linux",
                packageManager: "pacman",
                shell: { executable: "/bin/bash", kind: "bash", version: "5" },
            },
        },
        hasToolSchemaCache() {
            return options.hasSchema ?? true;
        },
        listTools() {
            return options.tools ?? [bashTool];
        },
        snapshot() {
            return { ready: options.ready ?? true };
        },
    };
}

async function rewrittenEndpoint(
    toolName: string,
    remote: boolean,
    reject = false,
) {
    const state = createTestMcpRuntimeState();
    await state.contexts.initialize();
    const originalWorkspace = await createTestTempDirectory("mcp-original");
    const finalWorkspace = await createTestTempDirectory("mcp-final");
    const original = await state.contexts.registry.create({
        environments: [{ instance: "main-pc", workspace: originalWorkspace }],
        principal: "local",
    });
    const instance = remote ? "final" : "main-pc";
    const final = await state.contexts.registry.create({
        environments: [{ instance, workspace: finalWorkspace }],
        principal: "local",
    });
    const changes: Array<[string, ...unknown[]]> = [];
    const inputs: JsonValue[] = [];
    const provenance: unknown[] = [];
    const values: ToolCallHookValue[] = [];
    const callIds: string[] = [];
    const reviews: string[] = [];
    const denials: Array<{ instance: string; toolName: string }> = [];
    const pipeline = createToolCallRuntime({
        resolveTarget(target) {
            // Rejected inbound review occurs before rewrite and belongs to the original Instance.
            assert.equal(target, reject ? "main-pc" : instance);
            return {
                async dispatch(request): Promise<JsonValue> {
                    if (request.rejection !== undefined) {
                        denials.push({ instance: target, toolName: request.value.toolName });
                        throw Object.assign(new Error(request.rejection.message), {
                            code: request.rejection.code,
                        });
                    }
                    values.push(request.value);
                    callIds.push(request.callId);
                    inputs.push(await request.invocationInput?.(
                        request.value.payload,
                        request.callId,
                        request.value,
                    ) ?? request.value.payload);
                    if (request.value.toolName.startsWith("ext_")) {
                        changes.push([
                            "extension", target, request.value.toolName,
                            inputs.at(-1), request.value.context,
                        ]);
                        return await request.transformResult?.({}, request.callId) ?? {};
                    }
                    changes.push(["ready", target]);
                    changes.push(["workspace", target, finalWorkspace]);
                    changes.push(["event", target, request.value.toolName, request.value.context]);
                    if (["bash_run", "task_input"].includes(request.value.toolName)) {
                        changes.push(["internal", target, request.value.toolName, request.value.context]);
                    }
                    return await request.transformResult?.({
                        task: { id: "final-task", status: "0", pty: false },
                        termination: "exited", exitCode: 0, stdout: "ready", stderr: "",
                        waitReason: "terminal",
                    }, request.callId) ?? {};
                },
            };
        },
    });
    pipeline.hooks.registerContributor(() => ({
        reviews: [{
            hook: "test.review",
            id: "mcp-endpoint-review",
            review({ value }) {
                reviews.push(value.context.instance);
                return reject
                    ? { decision: "reject", reason: "blocked" }
                    : { decision: "continue" };
            },
        }],
        rewrites: [{
            hook: "test.rewrite",
            id: "mcp-endpoint-rewrite",
            rewrite({ value }) {
                return {
                    ...value,
                    toolName,
                    payload: (toolName === "bash_run"
                        ? { command: "rewritten", waitMs: 180000 }
                        : toolName === "task_input"
                            ? { task: "final-task", waitMs: 120000, untilExit: true }
                            : toolName === "file_read" ? { files: [{ path: "rewritten" }] } : {}) as JsonValue,
                    context: {
                        ...value.context,
                        instance: asInstanceName(instance),
                        ctxId: final.ctxId,
                        workspace: finalWorkspace,
                    },
                };
            },
        }],
        release() {},
    }));
    const definitions = [
        bashTool,
        fileReadTool,
        { ...bashTool, group: "task", name: "task_input" },
        { ...bashTool, group: "ext", name: "ext_original" },
        { ...bashTool, group: "ext", name: "ext_final" },
    ];
    const endpointTools: ToolCallApi = pipeline.api;
    const endpoint = createManagedEndpoint(
        createWorker({
            tools: [
                bashTool,
                fileReadTool,
                { ...bashTool, group: "task", name: "task_input" },
            ],
        }),
        endpointTools,
        {
            contextState: state,
            toolDefinitions: definitions,
            toolProvenance: { async record(value) { provenance.push(value); } },
        },
    );
    endpoint.listTools();
    return {
        endpoint,
        registry: state.contexts.registry,
        original,
        final,
        instance,
        finalWorkspace,
        changes,
        inputs,
        provenance,
        values,
        callIds,
        reviews,
        denials,
        async close() {
            state.toolCallRuntime.close();
            await state.contexts.close();
        },
    };
}

for (const remote of [true, false]) {
    test(`MCP accepted bookkeeping uses final instance, tool and Context (${remote ? "remote" : "local"})`, async () => {
        const h = await rewrittenEndpoint("file_read", remote);
        // lastAccessedAt is persisted at millisecond precision. Ensure the
        // initial record's millisecond has elapsed before asserting a touch;
        // otherwise a correct touch can retain the same ISO timestamp.
        await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.max(1, Date.parse(h.final.lastAccessedAt) - Date.now() + 2)),
        );
        await h.endpoint.callTool(
            "bash_run",
            {
                ctxId: h.original.ctxId,
                command: "original",
                purpose: "final target",
            },
            context,
        );
        assert.deepEqual(h.reviews, ["main-pc"]);
        assert.deepEqual(
            h.changes.filter((change) => change[0] === "ready"),
            [
                ["ready", h.instance],
            ],
        );
        assert.deepEqual(
            h.changes.find((change) => change[0] === "workspace"),
            ["workspace", h.instance, h.finalWorkspace],
        );
        assert.deepEqual(
            h.changes.find((change) => change[0] === "event"),
            ["event", h.instance, "file_read", h.values[0]!.context],
        );
        assert.deepEqual(h.provenance, [
            {
                callId: h.callIds[0],
                instance: h.instance,
                purpose: "final target",
            },
        ]);
        assert.equal(
            (await h.registry.validate(h.original.ctxId, context))
                .lastAccessedAt,
            h.original.lastAccessedAt,
        );
        assert.notEqual(
            (await h.registry.validate(h.final.ctxId, context)).lastAccessedAt,
            h.final.lastAccessedAt,
        );
        await h.close();
    });
}

for (const name of ["bash_run", "task_input"]) {
    test(`${name} adapts final rewritten input and finishes against final Context`, async () => {
        const h = await rewrittenEndpoint(name, true);
        await h.endpoint.callTool(
            name,
            {
                ctxId: h.original.ctxId,
                ...(name === "bash_run"
                    ? { command: "original", waitMs: 180000 }
                    : { task: "original-task", waitMs: 120000, untilExit: true }),
                purpose: "process",
            },
            context,
        );
        assert.deepEqual(
            h.inputs[0],
            name === "bash_run"
                ? { command: "rewritten", waitMs: 180000 }
                : { task: "final-task", waitMs: 120000, untilExit: true },
        );
        const internal = h.changes.find(
            (change) => change[0] === "internal",
        ) as [string, string, string, ToolCallContext];
        assert.equal(internal[1], "final");
        assert.equal(internal[3].ctxId, h.final.ctxId);
        await h.close();
    });
}

for (const name of ["bash_run", "ext_original", "task_input"]) {
    test(`${name} rejected review leaves accepted MCP state untouched`, async () => {
        const h = await rewrittenEndpoint(name, true, true);
        await assert.rejects(
            h.endpoint.callTool(
                name,
                {
                ctxId: h.original.ctxId,
                    ...(name === "bash_run" ? { command: "original", waitMs: 180000 }
                        : name === "task_input" ? { task: "original-task", waitMs: 120000 } : {}),
                    purpose: "rejected",
                },
                context,
            ),
            { code: "core.toolCallRejected" },
        );
        assert.deepEqual(h.denials, [{ instance: "main-pc", toolName: name }]);
        assert.deepEqual(h.changes, []);
        assert.deepEqual(h.values, []);
        assert.deepEqual(h.provenance, []);
        assert.deepEqual(
            await h.registry.validate(h.original.ctxId, context),
            h.original,
        );
        await h.close();
    });
}
