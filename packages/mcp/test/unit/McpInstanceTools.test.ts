import assert from "node:assert/strict";
import test from "node:test";

import type {
    JsonValue,
    ToolCallContext,
    ToolDefinition
} from "@portable-devshell/shared";
import {
    McpContextInstanceConnector,
    McpContextRegistry,
    McpEndpointWorker,
    type McpInstanceGateway
} from "@portable-devshell/mcp/testing";
import { withMcpContextId, withMcpInstanceTarget } from "../../src/endpoint/McpEndpointInput.ts";

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

test("instance attachment is absent from MCP while gateway routing remains available", () => {
    const worker = createWorker();
    const gateway = createGateway();
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        worker
    });
    const tools = endpoint.listTools();

    for (const name of ["instance_connect", "instance_list", "instance_status", "instance_create", "instance_stop"]) {
        assert.equal(tools.some((tool) => tool.name === name), false, name);
    }
    assert.notEqual(
        (tools.find((tool) => tool.name === "bash_run")?.inputSchema as { properties?: Record<string, unknown> }).properties?.instance,
        undefined
    );
});

test("gateway-enabled endpoint augments worker schemas without exposing instance management tools", () => {
    const endpoint = createManagedEndpoint();
    const tools = endpoint.listTools();

    assert.notEqual(
        (tools.find((tool) => tool.name === "bash_run")?.inputSchema as { properties?: Record<string, unknown> }).properties?.instance,
        undefined
    );
    assert.equal(
        (tools.find((tool) => tool.name === "environ_info")?.inputSchema as { properties?: Record<string, unknown> }).properties?.instance,
        undefined
    );
    for (const name of ["instance_connect", "instance_list", "instance_status", "instance_create", "instance_stop"]) {
        assert.equal(tools.some((tool) => tool.name === name), false, name);
    }
});

test("environ_info never accepts a cross-instance target", async () => {
    await assert.rejects(
        createManagedEndpoint().callTool(
            "environ_info",
            { instance: "remote-server", workspace: "/remote-workspace" },
            context
        ),
        /environ_info accepts only optional ctxId and workspace/u
    );
});

test("routing fields are injected into strict worker schema union branches", () => {
    const unionTool: ToolDefinition = {
        requiredCapabilities: ["execute"],
        description: "Union tool",
        group: "tmux",
        inputSchema: {
            $defs: {
                Pane: {
                    additionalProperties: false,
                    properties: { pane: { type: "string" } },
                    required: ["pane"],
                    type: "object"
                },
                Task: {
                    additionalProperties: false,
                    properties: { task: { type: "string" } },
                    required: ["task"],
                    type: "object"
                }
            },
            anyOf: [{ $ref: "#/$defs/Task" }, { $ref: "#/$defs/Pane" }]
        },
        name: "tmux_input",
        outputSchema: { type: "object" }
    };
    const schema = withMcpInstanceTarget(withMcpContextId(unionTool)).inputSchema as {
        $defs?: Record<string, {
            properties?: Record<string, unknown>;
            required?: string[];
        }>;
    };
    for (const branch of Object.values(schema.$defs ?? {})) {
        assert.notEqual(branch.properties?.ctxId, undefined);
        assert.notEqual(branch.properties?.instance, undefined);
        assert.equal(branch.required?.includes("ctxId"), true);
        assert.equal(branch.required?.includes("instance"), false);
    }
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
    const connector = new McpContextInstanceConnector({
        contextRegistry,
        gateway: () => gateway
    });
    await connector.connect(activeContext.ctxId, "remote-server", "/remote-workspace");
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

test("Context instance connector reuses a live workspace attachment and releases a replaced alert lease", async () => {
    const registry = new McpContextRegistry({ idFactory: () => "ctx-connect-idempotent" });
    const created = await registry.create({
        instance: "main-pc",
        principal: "local",
        workspace: "/workspace"
    });
    let prepareCalls = 0;
    const touchedTemporary: string[] = [];
    const touchedAlerts: string[] = [];
    const releasedAlerts: string[] = [];
    const gateway = createGateway({
        async prepareWorkspace(instance, workspace) {
            prepareCalls += 1;
            return {
                projectMemoryAgentFile: `${workspace}/AGENT.md`,
                projectMemoryDirectory: `${workspace}/.memory`,
                projectMemoryPresent: true,
                temporaryDirectory: `/tmp/${instance}-${prepareCalls}`,
                workspace
            };
        },
        async releaseAlerts(_instance, workspace) {
            releasedAlerts.push(workspace);
        },
        async touchAlerts(_instance, workspace) {
            touchedAlerts.push(workspace);
        },
        async touchTemporaryDirectory(_instance, path) {
            touchedTemporary.push(path);
        }
    });
    const connector = new McpContextInstanceConnector({
        contextRegistry: registry,
        gateway: () => gateway
    });
    const call = async (workspace: string) => await connector.connect(created.ctxId, "remote-server", workspace);

    await call("/remote-a");
    await call("/remote-a");
    await call("/remote-b");

    assert.equal(prepareCalls, 2);
    assert.deepEqual(touchedTemporary, ["/tmp/remote-server-1"]);
    assert.deepEqual(touchedAlerts, ["/remote-a"]);
    assert.deepEqual(releasedAlerts, ["/remote-a"]);
});

test("Context instance connector cleans an unused alert lease and reference when workspace preparation fails", async () => {
    const registry = new McpContextRegistry({ idFactory: () => "ctx-connect-failure" });
    const created = await registry.create({
        instance: "main-pc",
        principal: "local",
        workspace: "/workspace"
    });
    const releasedAlerts: string[] = [];
    const releasedReferences: string[] = [];
    const gateway = createGateway({
        async prepareWorkspace(instance, workspace) {
            return {
                projectMemoryAgentFile: `${workspace}/AGENT.md`,
                projectMemoryDirectory: `${workspace}/.memory`,
                projectMemoryPresent: true,
                temporaryDirectory: `/tmp/${instance}`,
                workspace
            };
        },
        async readAlerts() {
            throw new Error("alerts failed");
        },
        async releaseAlerts(_instance, workspace) {
            releasedAlerts.push(workspace);
        },
        async releaseInstanceReference(instance, reference) {
            releasedReferences.push(`${instance}:${reference}`);
        }
    });
    const connector = new McpContextInstanceConnector({
        contextRegistry: registry,
        gateway: () => gateway
    });

    await assert.rejects(
        connector.connect(created.ctxId, "remote-server", "/remote-fail"),
        /alerts failed/u
    );
    assert.deepEqual(releasedAlerts, ["/remote-fail"]);
    assert.deepEqual(releasedReferences, [`remote-server:${created.ctxId}`]);
});

test("remote bash artifacts tell artifact_read to stay on the source instance", async () => {
    const registry = new McpContextRegistry({ idFactory: () => "ctx-remote-artifact" });
    const created = await registry.create({
        instance: "main-pc",
        principal: "local",
        workspace: "/workspace"
    });
    await registry.attachEnvironment(created.ctxId, {
        instance: "remote-server",
        temporaryDirectory: "/tmp/remote-artifact",
        workspace: "/remote-workspace"
    });
    const gateway = createGateway({
        async callTool() {
            return {
                exitCode: 0,
                stderr: "",
                stderrTruncated: false,
                stdout: "partial",
                stdoutArtifact: { handle: "artifact-1" },
                stdoutTruncated: true,
                termination: "exited"
            };
        }
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry: registry,
        gateway,
        instanceName: "main-pc",
        worker: createWorker()
    });

    const result = await endpoint.callTool(
        "bash_run",
        { command: "produce-output", ctxId: created.ctxId, instance: "remote-server" },
        context
    ) as { comment?: string[] };
    assert.deepEqual(result.comment, [
        `[bash.outputTruncated] Read full stdout with artifact_read using instance "remote-server".`
    ]);
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

test("cancelling Context instance attachment stops model waiting while the gateway operation continues", async () => {
    let resolveStart!: (value: JsonValue) => void;
    const start = new Promise<JsonValue>((resolve) => {
        resolveStart = resolve;
    });
    const gateway = createGateway({
        async connectInstance() {
            return await start;
        }
    });
    const connector = new McpContextInstanceConnector({
        contextRegistry,
        gateway: () => gateway
    });
    const controller = new AbortController();
    const pending = connector.connect(activeContext.ctxId, "remote-server", undefined, controller.signal);

    controller.abort(new Error("gateway timeout"));
    await assert.rejects(pending, /gateway timeout/u);
    resolveStart({ instance: "remote-server", state: "running" });
    await start;
});

test("Context instance attachment is independent from local Worker readiness", async () => {
    const calls: string[] = [];
    const gateway = createGateway({
        connectInstance: async (instance) => {
            calls.push(`connect:${instance}`);
            return { instance };
        }
    });
    const connector = new McpContextInstanceConnector({
        contextRegistry,
        gateway: () => gateway
    });

    await connector.connect(activeContext.ctxId, "remote-server");
    assert.deepEqual(calls, ["connect:remote-server"]);
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
        async callTool(instance, toolName, input, callContext, signal, transformResult) {
            const result = overrides.callTool === undefined
                ? { instance, toolName }
                : await overrides.callTool(instance, toolName, input, callContext, signal);
            return transformResult === undefined
                ? result
                : await transformResult(result, "call-test");
        },
        environment(instance) {
            return overrides.environment?.(instance) ?? {
                homeDirectory: "/remote",
                instance,
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
                projectMemoryPresent: true,
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
        async readTodo(instance, input) {
            return await (overrides.readTodo?.(instance, input) ?? Promise.resolve({ items: [], revision: 0, summary: { completed: 0, total: 0 } }));
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

test("todo tools are fixed control-side primitives and remain available while the worker is stopped", async () => {
    const calls: string[] = [];
    const gateway = createGateway({
        async readTodo(instance, input) {
            calls.push(`read:${instance}:${input?.taskId ?? input?.title ?? "all"}`);
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
        worker: createWorker({ hasSchema: false, ready: false })
    });

    assert.deepEqual(await endpoint.callTool("todo_read", withContext({}), context), {
        items: [],
        revision: 0,
        summary: { completed: 0, total: 0 }
    });
    const todoReadSchema = endpoint.listTools().find((tool) => tool.name === "todo_read")?.outputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
    };
    assert.equal(todoReadSchema.required?.includes("revision"), true);
    assert.notEqual(todoReadSchema.properties?.items, undefined);
    assert.notEqual(todoReadSchema.properties?.summary, undefined);
    assert.notEqual(todoReadSchema.properties?.tasks, undefined);
    const todoWriteSchema = endpoint.listTools().find((tool) => tool.name === "todo_write")?.inputSchema as {
        properties?: {
            todos?: {
                contains?: unknown;
                items?: { allOf?: unknown; properties?: Record<string, unknown> };
                maxContains?: unknown;
                minContains?: unknown;
            };
        };
    };
    assert.deepEqual(
        Object.keys(todoWriteSchema.properties?.todos?.items?.properties ?? {}).sort(),
        ["content", "detail", "id", "status"]
    );
    assert.equal(todoWriteSchema.properties?.todos?.items?.allOf, undefined);
    assert.equal(todoWriteSchema.properties?.todos?.contains, undefined);
    assert.equal(todoWriteSchema.properties?.todos?.minContains, undefined);
    assert.equal(todoWriteSchema.properties?.todos?.maxContains, undefined);
    await endpoint.callTool("todo_read", withContext({ title: "Recover" }), context);
    await endpoint.callTool("todo_read", withContext({ taskId: "task-recover" }), context);
    await endpoint.callTool("todo_write", withContext({ revision: 0, title: "Recover", todos: [] }), context);
    assert.deepEqual(calls, [
        "read:main-pc:all",
        "read:main-pc:Recover",
        "read:main-pc:task-recover",
        "write:main-pc:ctx-instance-test:0"
    ]);

    assert.equal(endpoint.listTools().some((tool) => tool.name === "todo_read"), true);
});

test("openai-session binding uses the same Todo contract as explicit ctxId", async () => {
    const registry = new McpContextRegistry({ idFactory: () => "ctx-session-todo" });
    const current = await registry.create({
        instance: "main-pc",
        principal: "local",
        workspace: "/workspace"
    });
    await registry.bindExternal(current.ctxId, { kind: "openai/session", value: "chat-session-todo" }, {
        principal: "local"
    });
    const tasks = [
        {
            completed: 0,
            ctxId: current.ctxId,
            revision: 1,
            status: "in_progress",
            taskId: "task-current",
            title: "Current task",
            total: 1,
            updatedAt: "2026-08-20T00:00:00.000Z"
        },
        {
            completed: 0,
            ctxId: "ctx-other-session",
            revision: 2,
            status: "paused",
            taskId: "task-other",
            title: "Other task",
            total: 2,
            updatedAt: "2026-08-19T00:00:00.000Z"
        }
    ];
    const gateway = createGateway({
        async readTodo() {
            return { items: [], revision: 0, summary: { completed: 0, total: 0 }, tasks };
        }
    });
    const endpoint = new McpEndpointWorker({
        contextMode: "openai-session",
        contextRegistry: registry,
        gateway,
        instanceName: "main-pc",
        worker: createWorker({ hasSchema: false, ready: false })
    });
    const requestContext = {
        principal: "local",
        requestId: "request-session-todo",
        requestMeta: { "openai/session": "chat-session-todo" }
    } as const;

    const discovered = await endpoint.callTool("todo_read", {}, requestContext) as {
        tasks?: Array<Record<string, unknown>>;
    };
    assert.deepEqual(discovered.tasks?.map((task) => task.taskId), ["task-current", "task-other"]);
    assert.equal(discovered.tasks?.[0]?.ctxId, current.ctxId);

    const todoTool = endpoint.listTools().find((tool) => tool.name === "todo_read");
    const schema = todoTool?.outputSchema as {
        properties?: { tasks?: { items?: { properties?: Record<string, unknown> } } };
    };
    assert.notEqual(schema.properties?.tasks?.items?.properties?.ctxId, undefined);
    assert.notEqual(
        (todoTool?.inputSchema as { properties?: Record<string, unknown> }).properties?.title,
        undefined
    );
});
