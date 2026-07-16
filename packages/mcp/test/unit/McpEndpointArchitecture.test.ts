import assert from "node:assert/strict";
import test from "node:test";

import type {
    JsonValue,
    ToolCallContext,
    ToolDefinition
} from "@portable-devshell/shared";

import { McpEndpointCatalog } from "../../dist/endpoint/McpEndpointCatalog.js";
import { McpEndpointDispatch } from "../../dist/endpoint/McpEndpointDispatch.js";

function workerTool(name: string = "bash_run"): ToolDefinition {
    return {
        description: "Run a command.",
        group: "bash",
        inputSchema: {
            additionalProperties: false,
            properties: {
                command: { type: "string" }
            },
            required: ["command"],
            type: "object"
        },
        name,
        outputSchema: {
            type: "object"
        },
        requiredCapabilities: ["execute"]
    };
}

function createWorker(options: {
    cached?: boolean;
    ready?: boolean;
    tools?: ToolDefinition[];
} = {}) {
    const events: Array<{ type: string; data?: JsonValue }> = [];
    const calls: Array<{
        context: ToolCallContext;
        input: JsonValue;
        toolName: string;
    }> = [];
    const audited: string[] = [];
    const worker = {
        async auditToolCall<T extends JsonValue>(
            toolName: string,
            _input: JsonValue,
            _context: ToolCallContext,
            operation: () => Promise<T>
        ): Promise<T> {
            audited.push(toolName);
            return await operation();
        },
        async appendMcpSessionClosed(sessionId: string): Promise<void> {
            events.push({ data: { sessionId }, type: "closed" });
        },
        async appendMcpSessionOpened(sessionId: string): Promise<void> {
            events.push({ data: { sessionId }, type: "opened" });
        },
        async appendMcpToolCalled(toolName: string, context: { requestId?: string; ctxId?: string }): Promise<void> {
            events.push({ data: { ...context, toolName } as JsonValue, type: "called" });
        },
        async callTool(
            toolName: string,
            input: JsonValue,
            context: ToolCallContext
        ): Promise<JsonValue> {
            calls.push({ context, input, toolName });
            return { ok: true, toolName };
        },
        handshake: {
            instance: "demo-local",
            platform: {
                arch: "x86_64",
                distribution: { id: "arch", name: "Arch Linux" },
                os: "linux",
                packageManager: "pacman",
                shell: { executable: "/bin/bash", kind: "bash", version: "5" }
            },
            workspace: "/workspace"
        },
        hasToolSchemaCache: () => options.cached ?? false,
        listTools: () => options.tools ?? [workerTool()],
        snapshot: () => ({ ready: options.ready ?? true }),
        workspacePath: "/workspace"
    };
    return { audited, calls, events, worker };
}

test("McpEndpointCatalog independently owns merge, filtering, adaptation, and routing schema", () => {
    const harness = createWorker();
    const catalog = new McpEndpointCatalog({
        gateway: {
            listTools: () => []
        } as never,
        instanceName: "demo-local",
        policy: {
            capabilities: ["execute", "manage"],
            groups: ["bash", "instance"]
        },
        worker: harness.worker
    });

    const tools = catalog.listTools();
    assert.deepEqual(
        tools.map((tool) => tool.name),
        [
            "environ_info",
            "bash_run",
            "instance_list",
            "instance_status",
            "instance_create",
            "instance_start",
            "instance_stop"
        ]
    );

    const bash = tools.find((tool) => tool.name === "bash_run");
    assert.ok(bash);
    const schema = bash.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
    };
    assert.ok(schema.properties?.ctxId);
    assert.ok(schema.properties?.instance);
    assert.deepEqual(schema.required, ["command", "ctxId"]);
    assert.equal(catalog.getExposed("bash_run")?.owner, "worker");
    assert.equal(catalog.getKnown("todo_read")?.owner, "todo");
});

test("McpEndpointCatalog keeps control tools available without a worker schema", () => {
    const harness = createWorker({ cached: false, ready: false, tools: [] });
    const catalog = new McpEndpointCatalog({
        gateway: {
            listTools: () => []
        } as never,
        instanceName: "demo-local",
        policy: {
            capabilities: ["manage"],
            groups: ["instance"]
        },
        worker: harness.worker
    });

    assert.deepEqual(
        catalog.listTools().map((tool) => tool.name),
        [
            "environ_info",
            "instance_list",
            "instance_status",
            "instance_create",
            "instance_start",
            "instance_stop"
        ]
    );
    assert.equal(catalog.snapshot().hasWorkerSchema, false);
});

test("McpEndpointDispatch executes environment, control, and worker domains without HTTP binding", async () => {
    const harness = createWorker();
    const gateway = {
        assertReady() {},
        async callTool(): Promise<JsonValue> {
            return { remote: true };
        },
        async createSshInstance(): Promise<JsonValue> {
            return { created: true };
        },
        async listInstances(): Promise<JsonValue[]> {
            return [{ name: "demo-local" }];
        },
        listTools: () => [],
        async readTodo(): Promise<JsonValue> {
            return { items: [], revision: 0 };
        },
        async startInstance(): Promise<JsonValue> {
            return { started: true };
        },
        async statusInstance(): Promise<JsonValue> {
            return { state: "running" };
        },
        async stopInstance(): Promise<JsonValue> {
            return { stopped: true };
        },
        async writeTodo(): Promise<JsonValue> {
            return { revision: 1 };
        }
    } as never;
    const catalog = new McpEndpointCatalog({
        gateway,
        instanceName: "demo-local",
        policy: {
            capabilities: ["execute", "manage", "read", "write"],
            groups: ["bash", "instance", "todo"]
        },
        worker: harness.worker
    });
    const dispatch = new McpEndpointDispatch({
        catalog,
        gateway,
        instanceName: "demo-local",
        worker: harness.worker
    });

    const environment = await dispatch.callTool(
        "environ_info",
        {},
        { principal: "tester", requestId: "request-environment" }
    ) as { ctxId: string; workspace: string };
    assert.equal(environment.workspace, "/workspace");
    assert.equal(typeof environment.ctxId, "string");

    const listed = await dispatch.callTool(
        "instance_list",
        { ctxId: environment.ctxId },
        { principal: "tester", requestId: "request-list" }
    );
    assert.deepEqual(listed, { instances: [{ name: "demo-local" }] });

    const workerResult = await dispatch.callTool(
        "bash_run",
        { command: "pwd", ctxId: environment.ctxId },
        { principal: "tester", requestId: "request-worker" }
    );
    assert.deepEqual(workerResult, { ok: true, toolName: "bash_run" });
    assert.deepEqual(harness.calls[0]?.input, { command: "pwd" });
    assert.deepEqual(harness.audited, ["environ_info", "instance_list"]);
});
