import assert from "node:assert/strict";
import test from "node:test";

import type {
    JsonValue,
    ToolCallContext,
    ToolDefinition
} from "@portable-devshell/shared";
import {
    McpContextRegistry,
    McpEndpointWorker,
    type McpInstanceGateway,
    type McpSshInstanceCreateInput
} from "@portable-devshell/mcp/testing";

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

const context = { principal: "local", requestId: "request-1" } as const;
const contextRegistry = new McpContextRegistry({ idFactory: () => "ctx-instance-test" });
const activeContext = await contextRegistry.create({
    instance: "main-pc",
    principal: "local",
    workspace: "/workspace"
});
const withContext = <T extends Record<string, unknown>>(input: T): T & { ctxId: string } => ({
    ...input,
    ctxId: activeContext.ctxId
});

test("instance tools are hidden unless instance group and manage capability are both enabled", () => {
    const worker = createWorker();
    const gateway = createGateway();
    const withoutManage = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: ["execute"], groups: ["bash", "instance"] },
        worker
    });
    const withoutGroup = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: ["execute", "manage"], groups: ["bash"] },
        worker
    });

    assert.equal(withoutManage.listTools().some((tool) => tool.name === "instance_list"), false);
    assert.equal(withoutGroup.listTools().some((tool) => tool.name === "instance_list"), false);
    assert.equal((withoutManage.listTools().find((tool) => tool.name === "bash_run")?.inputSchema as { properties?: Record<string, unknown> }).properties?.instance, undefined);
});

test("management-enabled endpoint augments worker schemas for cross-instance routing", () => {
    const endpoint = createManagedEndpoint();
    const tools = endpoint.listTools();

    assert.notEqual(
        (tools.find((tool) => tool.name === "bash_run")?.inputSchema as { properties?: Record<string, unknown> }).properties?.instance,
        undefined
    );
    assert.equal(tools.some((tool) => tool.name === "instance_list"), true);
    const connectSchema = tools.find((tool) => tool.name === "instance_connect")?.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
    };
    assert.notEqual(connectSchema.properties?.ctxId, undefined);
    assert.notEqual(connectSchema.properties?.workspace, undefined);
    assert.equal(connectSchema.required?.includes("ctxId"), true);
});

test("worker calls default to the endpoint instance and route explicit targets through the gateway", async () => {
    const localCalls: Array<{ input: JsonValue; toolName: string }> = [];
    const remoteCalls: Array<{ context: ToolCallContext; input: JsonValue; instance: string; toolName: string }> = [];
    const worker = createWorker({
        callTool: async (toolName, input) => {
            localCalls.push({ input, toolName });
            return { local: true };
        }
    });
    const gateway = createGateway({
        callTool: async (instance, toolName, input, callContext) => {
            remoteCalls.push({ context: callContext, input, instance, toolName });
            return { remote: true };
        }
    });
    const endpoint = createManagedEndpoint(worker, gateway);

    assert.deepEqual(await endpoint.callTool("bash_run", withContext({ command: "pwd" }), context), { local: true });
    await assert.rejects(
        endpoint.callTool("bash_run", withContext({ command: "pwd", instance: "remote-server" }), context),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "mcp.contextWorkspaceRequired");
            return true;
        }
    );
    await endpoint.callTool(
        "instance_connect",
        withContext({ instance: "remote-server", workspace: "/remote-workspace" }),
        context
    );
    assert.deepEqual(
        await endpoint.callTool("bash_run", withContext({ command: "pwd", instance: "remote-server" }), context),
        { remote: true }
    );
    assert.deepEqual(localCalls, [{ input: { command: "pwd" }, toolName: "bash_run" }]);
    assert.deepEqual(remoteCalls, [{
        context: {
            ctxId: activeContext.ctxId,
            requestId: "request-1",
            source: "mcp",
            workspace: "/remote-workspace"
        },
        input: { command: "pwd" },
        instance: "remote-server",
        toolName: "bash_run"
    }]);

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
    const endpoint = createManagedEndpoint(createWorker(), gateway, { readyWaitMs: 50 });

    await contextRegistry.attachEnvironment(activeContext.ctxId, {
        instance: "remote-server",
        temporaryDirectory: "/tmp/remote-context",
        workspace: "/remote-workspace"
    });
    await assert.rejects(
        endpoint.callTool("bash_run", withContext({ command: "pwd", instance: "remote-server" }), context),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "core.instanceNotReady");
            return true;
        }
    );
    assert.equal(listToolsCalled, false);
});

test("worker tools missing from the endpoint catalog cannot be recovered from a remote instance", async () => {
    let remoteCalled = false;
    const gateway = createGateway({
        assertReady() {},
        async callTool() {
            remoteCalled = true;
            return { remote: true };
        },
        listTools() {
            return [bashTool];
        }
    });
    const endpoint = createManagedEndpoint(createWorker({ hasSchema: false, ready: false }), gateway);

    await assert.rejects(
        endpoint.callTool(
            "bash_run",
            withContext({ command: "pwd", instance: "remote-server" }),
            context
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "core.toolSchemaUnavailable");
            return true;
        }
    );
    assert.equal(remoteCalled, false);
});

test("cancelling an instance lifecycle tool stops MCP waiting while the operation continues", async () => {
    let resolveStart!: (value: JsonValue) => void;
    const start = new Promise<JsonValue>((resolve) => {
        resolveStart = resolve;
    });
    const gateway = createGateway({
        async connectInstance() {
            return await start;
        }
    });
    const endpoint = createManagedEndpoint(createWorker({ hasSchema: false, ready: false }), gateway);
    const controller = new AbortController();
    const pending = endpoint.callTool(
        "instance_connect",
        withContext({ instance: "remote-server" }),
        context,
        controller.signal
    );

    controller.abort("gateway timeout");
    await assert.rejects(pending, (error: unknown) => {
        assert.equal((error as { code?: string }).code, "core.toolCallCancelled");
        return true;
    });
    resolveStart({ instance: "remote-server", state: "running" });
    await start;
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
        connectInstance: async (instance) => {
            calls.push(`connect:${instance}`);
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

    assert.deepEqual(await endpoint.callTool("instance_list", withContext({}), context), { instances: [] });
    await endpoint.callTool("instance_status", withContext({ instance: "remote-server" }), context);
    await endpoint.callTool("instance_connect", withContext({ instance: "remote-server" }), context);
    await endpoint.callTool("instance_stop", withContext({ instance: "remote-server" }), context);
    await endpoint.callTool(
        "instance_create",
        withContext({
            host: "server.example.com",
            identityFile: "~/.ssh/id_ed25519",
            name: "remote-server",
            port: 2222,
            user: "dev"
        }),
        context
    );

    assert.deepEqual(calls, [
        "list",
        "status:remote-server",
        "connect:remote-server",
        "stop:remote-server",
        "create:main-pc"
    ]);
    assert.deepEqual(createInput, {
        host: "server.example.com",
        identityFile: "~/.ssh/id_ed25519",
        name: "remote-server",
        port: 2222,
        user: "dev"
    });
});

function createManagedEndpoint(
    worker = createWorker(),
    gateway = createGateway(),
    options?: { readyWaitMs?: number }
): McpEndpointWorker {
    return new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        policy: {
            capabilities: ["execute", "manage"],
            groups: ["bash", "instance"]
        },
        readyWaitMs: options?.readyWaitMs,
        worker
    });
}

function createWorker(options: {
    callTool?: (toolName: string, input: JsonValue, context: ToolCallContext) => Promise<JsonValue>;
    hasSchema?: boolean;
    ready?: boolean;
} = {}) {
    return {
        async auditToolCall<T extends JsonValue>(
            _toolName: string,
            _input: JsonValue,
            _context: ToolCallContext,
            operation: (callId: string) => Promise<T>
        ): Promise<T> { return await operation("call-test"); },
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async callTool(toolName: string, input: JsonValue, callContext: ToolCallContext) {
            return await (options.callTool?.(toolName, input, callContext) ?? Promise.resolve({ ok: true }));
        },
        async readAlerts() {
            return { advice: [] };
        },
        handshake: {
            homeDirectory: "/home/demo",
            instance: "main-pc",
            skillsDirectory: "/home/demo/.devshell/skill",
            platform: {
                arch: "x86_64",
                distribution: { id: "arch", name: "Arch Linux", version: "rolling" },
                os: "linux",
                packageManager: "pacman",
                shell: { executable: "/bin/bash", kind: "bash", version: "5" }
            }
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
        async appendMcpToolCalled(instance, toolName, callContext) {
            await overrides.appendMcpToolCalled?.(instance, toolName, callContext);
        },
        assertReady(instance) {
            overrides.assertReady?.(instance);
        },
        async auditToolCall<T extends JsonValue>(
            instance: string,
            toolName: string,
            input: JsonValue,
            callContext: ToolCallContext,
            operation: (callId: string) => Promise<T>,
            signal?: AbortSignal
        ): Promise<T> {
            if (overrides.auditToolCall !== undefined) {
                return await overrides.auditToolCall(instance, toolName, input, callContext, operation, signal);
            }
            return await operation("call-test");
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
        environment(instance) {
            return overrides.environment?.(instance) ?? {
                homeDirectory: "/remote",
                instance,
                skillsDirectory: "/remote/.devshell/skill",
                platform: { arch: "arm64", os: "darwin" }
            };
        },
        async listInstances() {
            return await (overrides.listInstances?.() ?? Promise.resolve([]));
        },
        listTools(instance) {
            return overrides.listTools?.(instance) ?? [bashTool];
        },
        async prepareWorkspace(instance, workspace) {
            return await (overrides.prepareWorkspace?.(instance, workspace) ?? Promise.resolve({
                projectMemoryAgentFile: `${workspace}/.memory/AGENT.md`,
                projectMemoryDirectory: `${workspace}/.memory`,
                temporaryDirectory: `/tmp/${instance}-context`,
                workspace
            }));
        },
        async readAlerts(instance, workspace) {
            return await (overrides.readAlerts?.(instance, workspace) ?? Promise.resolve({ advice: [] }));
        },
        async releaseAlerts(instance, workspace) {
            await overrides.releaseAlerts?.(instance, workspace);
        },
        async readTodo(instance, title) {
            return await (overrides.readTodo?.(instance, title) ?? Promise.resolve({ items: [], revision: 0, summary: { completed: 0, total: 0 } }));
        },
        async connectInstance(instance, reference) {
            return await (overrides.connectInstance?.(instance, reference) ?? Promise.resolve({ instance }));
        },
        async releaseInstanceReference(instance, reference) {
            await overrides.releaseInstanceReference?.(instance, reference);
        },
        async statusInstance(instance) {
            return await (overrides.statusInstance?.(instance) ?? Promise.resolve({ instance }));
        },
        async stopInstance(instance) {
            return await (overrides.stopInstance?.(instance) ?? Promise.resolve({ instance }));
        },
        async touchAlerts(instance, workspace) {
            await overrides.touchAlerts?.(instance, workspace);
        },
        async touchTemporaryDirectory(instance, path) {
            await overrides.touchTemporaryDirectory?.(instance, path);
        },
        async writeTodo(instance, input, callContext) {
            return await (overrides.writeTodo?.(instance, input, callContext) ?? Promise.resolve({ items: [], revision: 1, summary: { completed: 0, total: 0 } }));
        }
    };
}

test("todo tools are control-side, group-controlled, capability-free, and available while the worker is stopped", async () => {
    const calls: string[] = [];
    const gateway = createGateway({
        async readTodo(instance, title) {
            calls.push(`read:${instance}:${title ?? "all"}`);
            return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
        },
        async writeTodo(instance, input, callContext) {
            calls.push(`write:${instance}:${callContext.ctxId}:${String((input as { revision?: number }).revision)}`);
            return { items: [], revision: 1, summary: { completed: 0, total: 0 } };
        }
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: [], groups: ["todo"] },
        worker: createWorker({ hasSchema: false, ready: false })
    });

    assert.deepEqual(await endpoint.callTool("todo_read", withContext({}), context), {
        items: [],
        revision: 0,
        summary: { completed: 0, total: 0 }
    });
    await endpoint.callTool("todo_read", withContext({ title: "Recover" }), context);
    await endpoint.callTool("todo_write", withContext({ revision: 0, title: "Recover", todos: [] }), context);
    assert.deepEqual(calls, ["read:main-pc:all", "read:main-pc:Recover", "write:main-pc:ctx-instance-test:0"]);

    const hidden = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        policy: { capabilities: ["read", "write"], groups: [] },
        worker: createWorker({ hasSchema: false, ready: false })
    });
    await assert.rejects(hidden.callTool("todo_read", withContext({}), context), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "core.toolSchemaUnavailable");
        return true;
    });
});
