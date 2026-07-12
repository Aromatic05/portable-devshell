import assert from "node:assert/strict";
import test from "node:test";

import type {
    JsonValue,
    ToolCallContext,
    ToolDefinition
} from "@portable-devshell/shared";
import {
    McpEndpointWorker,
    type McpInstanceGateway,
    type McpSshInstanceCreateInput
} from "@portable-devshell/mcp";

const bashTool: ToolDefinition = {
    requiredCapabilities: ["execute"],
    description: "Run a shell command.",
    group: "bash",
    inputSchema: {
        additionalProperties: false,
        properties: {
            command: { type: "string" }
        },
        required: ["command"],
        type: "object"
    },
    name: "bash_run",
    outputSchema: { type: "object" }
};

const context: ToolCallContext = {
    requestId: "request-1",
    sessionId: "session-1",
    source: "mcp"
};

test("instance tools are hidden unless instance group and manage capability are both enabled", () => {
    const worker = createWorker();
    const gateway = createGateway();
    const withoutManage = new McpEndpointWorker({
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: ["execute"], groups: ["bash", "instance"] },
        worker
    });
    const withoutGroup = new McpEndpointWorker({
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: ["execute", "manage"], groups: ["bash"] },
        worker
    });

    assert.deepEqual(withoutManage.listTools().map((tool) => tool.name), ["bash_run"]);
    assert.deepEqual(withoutGroup.listTools().map((tool) => tool.name), ["bash_run"]);
    assert.equal((withoutManage.listTools()[0]?.inputSchema as { properties?: Record<string, unknown> }).properties?.instance, undefined);
});

test("management-enabled endpoint exposes five instance tools and augments worker schemas", () => {
    const endpoint = createManagedEndpoint();
    const tools = endpoint.listTools();

    assert.deepEqual(tools.map((tool) => tool.name), [
        "bash_run",
        "instance_list",
        "instance_status",
        "instance_create",
        "instance_start",
        "instance_stop"
    ]);
    assert.notEqual(
        (tools.find((tool) => tool.name === "bash_run")?.inputSchema as { properties?: Record<string, unknown> }).properties?.instance,
        undefined
    );
});

test("worker calls default to the endpoint instance and route explicit targets through the gateway", async () => {
    const localCalls: Array<{ input: JsonValue; toolName: string }> = [];
    const remoteCalls: Array<{ input: JsonValue; instance: string; toolName: string }> = [];
    const worker = createWorker({
        callTool: async (toolName, input) => {
            localCalls.push({ input, toolName });
            return { local: true };
        }
    });
    const gateway = createGateway({
        callTool: async (instance, toolName, input) => {
            remoteCalls.push({ input, instance, toolName });
            return { remote: true };
        }
    });
    const endpoint = createManagedEndpoint(worker, gateway);

    assert.deepEqual(await endpoint.callTool("bash_run", { command: "pwd" }, context), { local: true });
    assert.deepEqual(
        await endpoint.callTool("bash_run", { command: "pwd", instance: "remote-server" }, context),
        { remote: true }
    );
    assert.deepEqual(localCalls, [{ input: { command: "pwd" }, toolName: "bash_run" }]);
    assert.deepEqual(remoteCalls, [{ input: { command: "pwd" }, instance: "remote-server", toolName: "bash_run" }]);
});

test("remote worker calls check target readiness before tool exposure", async () => {
    let listToolsCalled = false;
    const notReady = Object.assign(new Error("not ready"), {
        code: "core.instanceNotReady",
        details: { instance: "remote-server" },
        retryable: false
    });
    const gateway = createGateway({
        assertReady() {
            throw notReady;
        },
        listTools() {
            listToolsCalled = true;
            return [bashTool];
        }
    });
    const endpoint = createManagedEndpoint(createWorker(), gateway);

    await assert.rejects(
        endpoint.callTool("bash_run", { command: "pwd", instance: "remote-server" }, context),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "core.instanceNotReady");
            return true;
        }
    );
    assert.equal(listToolsCalled, false);
});

test("instance management tools delegate to the gateway without requiring the local worker to be ready", async () => {
    const calls: string[] = [];
    let createInput: McpSshInstanceCreateInput | undefined;
    const gateway = createGateway({
        createSshInstance: async (source, input) => {
            calls.push(`create:${source}`);
            createInput = input;
            return { name: input.name };
        },
        listInstances: async () => {
            calls.push("list");
            return [];
        },
        startInstance: async (instance) => {
            calls.push(`start:${instance}`);
            return { instance };
        },
        statusInstance: async (instance) => {
            calls.push(`status:${instance}`);
            return { instance };
        },
        stopInstance: async (instance) => {
            calls.push(`stop:${instance}`);
            return { instance };
        }
    });
    const endpoint = createManagedEndpoint(createWorker({ hasSchema: false, ready: false }), gateway);

    assert.deepEqual(endpoint.listTools().map((tool) => tool.name), [
        "instance_list",
        "instance_status",
        "instance_create",
        "instance_start",
        "instance_stop"
    ]);
    assert.deepEqual(await endpoint.callTool("instance_list", {}, context), { instances: [] });
    await endpoint.callTool("instance_status", { instance: "remote-server" }, context);
    await endpoint.callTool("instance_start", { instance: "remote-server" }, context);
    await endpoint.callTool("instance_stop", { instance: "remote-server" }, context);
    await endpoint.callTool(
        "instance_create",
        {
            host: "server.example.com",
            identityFile: "~/.ssh/id_ed25519",
            name: "remote-server",
            port: 2222,
            user: "dev",
            workspace: "/srv/project"
        },
        context
    );

    assert.deepEqual(calls, [
        "list",
        "status:remote-server",
        "start:remote-server",
        "stop:remote-server",
        "create:main-pc"
    ]);
    assert.deepEqual(createInput, {
        host: "server.example.com",
        identityFile: "~/.ssh/id_ed25519",
        name: "remote-server",
        port: 2222,
        user: "dev",
        workspace: "/srv/project"
    });
});

function createManagedEndpoint(
    worker = createWorker(),
    gateway = createGateway()
): McpEndpointWorker {
    return new McpEndpointWorker({
        gateway,
        instanceName: "main-pc",
        policy: {
            capabilities: ["execute", "manage"],
            groups: ["bash", "instance"]
        },
        worker
    });
}

function createWorker(options: {
    callTool?: (toolName: string, input: JsonValue, context: ToolCallContext) => Promise<JsonValue>;
    hasSchema?: boolean;
    ready?: boolean;
} = {}) {
    return {
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async callTool(toolName: string, input: JsonValue, callContext: ToolCallContext) {
            return await (options.callTool?.(toolName, input, callContext) ?? Promise.resolve({ ok: true }));
        },
        hasToolSchemaCache() {
            return options.hasSchema ?? true;
        },
        listTools() {
            return [bashTool];
        },
        snapshot() {
            return { ready: options.ready ?? true };
        }
    };
}

function createGateway(overrides: Partial<McpInstanceGateway> = {}): McpInstanceGateway {
    return {
        assertReady(instance) {
            overrides.assertReady?.(instance);
        },
        async callTool(instance, toolName, input, callContext) {
            if (overrides.callTool !== undefined) {
                return await overrides.callTool(instance, toolName, input, callContext);
            }
            return { instance, toolName };
        },
        async createSshInstance(sourceInstance, input) {
            if (overrides.createSshInstance !== undefined) {
                return await overrides.createSshInstance(sourceInstance, input);
            }
            return { name: input.name };
        },
        async listInstances() {
            return await (overrides.listInstances?.() ?? Promise.resolve([]));
        },
        listTools(instance) {
            return overrides.listTools?.(instance) ?? [bashTool];
        },
        async readTodo(instance) {
            return await (overrides.readTodo?.(instance) ?? Promise.resolve({ items: [], revision: 0, summary: { completed: 0, total: 0 } }));
        },
        async startInstance(instance) {
            return await (overrides.startInstance?.(instance) ?? Promise.resolve({ instance }));
        },
        async statusInstance(instance) {
            return await (overrides.statusInstance?.(instance) ?? Promise.resolve({ instance }));
        },
        async stopInstance(instance) {
            return await (overrides.stopInstance?.(instance) ?? Promise.resolve({ instance }));
        },
        async writeTodo(instance, input, callContext) {
            return await (overrides.writeTodo?.(instance, input, callContext) ?? Promise.resolve({ items: [], revision: 1, summary: { completed: 0, total: 0 } }));
        }
    };
}

test("todo tools are control-side, group-controlled, capability-free, and available while the worker is stopped", async () => {
    const calls: string[] = [];
    const gateway = createGateway({
        async readTodo(instance) {
            calls.push(`read:${instance}`);
            return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
        },
        async writeTodo(instance, input, callContext) {
            calls.push(`write:${instance}:${callContext.sessionId}:${String((input as { revision?: number }).revision)}`);
            return { items: [], revision: 1, summary: { completed: 0, total: 0 } };
        }
    });
    const endpoint = new McpEndpointWorker({
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: [], groups: ["todo"] },
        worker: createWorker({ hasSchema: false, ready: false })
    });

    assert.deepEqual(endpoint.listTools().map((tool) => tool.name), ["todo_read", "todo_write"]);
    assert.deepEqual(await endpoint.callTool("todo_read", {}, context), {
        items: [],
        revision: 0,
        summary: { completed: 0, total: 0 }
    });
    await endpoint.callTool("todo_write", { revision: 0, todos: [] }, context);
    assert.deepEqual(calls, ["read:main-pc", "write:main-pc:session-1:0"]);

    const hidden = new McpEndpointWorker({
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: ["read", "write"], groups: [] },
        worker: createWorker({ hasSchema: false, ready: false })
    });
    assert.throws(() => hidden.listTools(), /schema/u);
    await assert.rejects(hidden.callTool("todo_read", {}, context), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "core.toolSchemaUnavailable");
        return true;
    });
});
