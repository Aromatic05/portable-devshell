import assert from "node:assert/strict";
import test from "node:test";

import type {
    JsonValue,
    ToolCallContext,
    ToolDefinition
} from "@portable-devshell/shared";

import { McpEndpointCatalog } from "../../src/endpoint/McpEndpointCatalog.ts";
import { McpEndpointDispatch } from "../../src/endpoint/McpEndpointDispatch.ts";
import { McpNativeToolResult } from "../../src/endpoint/McpEndpointResult.ts";
import { McpContextRegistry } from "../../src/context/McpContextRegistry.ts";

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
            additionalProperties: false,
            properties: {
                exitCode: { type: ["integer", "null"] },
                stderr: { type: "string" },
                stdout: { type: "string" }
            },
            required: ["exitCode", "stderr", "stdout"],
            type: "object"
        },
        requiredCapabilities: ["execute"]
    };
}

function tmuxWaitTool(): ToolDefinition {
    return {
        description: "Wait for a managed tmux task.",
        group: "tmux",
        inputSchema: {
            additionalProperties: false,
            properties: { task: { type: "string" } },
            required: ["task"],
            type: "object",
        },
        name: "tmux_wait",
        outputSchema: { type: "object" },
        requiredCapabilities: ["read"],
    };
}

function createWorker(options: {
    cached?: boolean;
    failToolCalled?: boolean;
    ready?: boolean;
    tools?: ToolDefinition[];
} = {}) {
    const events: Array<{ type: string; data?: JsonValue }> = [];
    const calls: Array<{
        context: ToolCallContext;
        input: JsonValue;
        toolName: string;
    }> = [];
    const audited: Array<{ context: ToolCallContext; toolName: string }> = [];
    const releasedAlerts: string[] = [];
    const worker = {
        async auditToolCall<T extends JsonValue>(
            toolName: string,
            _input: JsonValue,
            context: ToolCallContext,
            operation: (callId: string) => Promise<T>
        ): Promise<T> {
            audited.push({ context, toolName });
            return await operation("call-test");
        },
        async appendMcpSessionClosed(sessionId: string): Promise<void> {
            events.push({ data: { sessionId }, type: "closed" });
        },
        async appendMcpSessionOpened(sessionId: string): Promise<void> {
            events.push({ data: { sessionId }, type: "opened" });
        },
        async appendMcpToolCalled(toolName: string, context: { requestId?: string; ctxId?: string }): Promise<void> {
            if (options.failToolCalled === true) throw new Error("tool event failed");
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
            homeDirectory: "/home/demo",
            instance: "demo-local",
            skillsDirectory: "/home/demo/.devshell/skill",
            platform: {
                arch: "x86_64",
                distribution: { id: "arch", name: "Arch Linux" },
                os: "linux",
                packageManager: "pacman",
                shell: { executable: "/bin/bash", kind: "bash", version: "5" }
            }
        },
        hasToolSchemaCache: () => options.cached ?? false,
        listTools: () => options.tools ?? [workerTool()],
        async prepareWorkspace(workspace: string) {
            return {
                projectMemoryAgentFile: `${workspace}/AGENT.md`,
                projectMemoryDirectory: workspace,
                temporaryDirectory: `${workspace}/tmp`,
                workspace: workspace,
            };
        },
        async readAlerts() {
            return { advice: [] };
        },
        async releaseAlerts(workspace: string) {
            releasedAlerts.push(workspace);
        },
        snapshot: () => ({ ready: options.ready ?? true }),
    };
    return { audited, calls, events, releasedAlerts, worker };
}

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

    const tools = catalog.listTools();
    assert.equal(tools.some((tool) => tool.name === "instance_list"), true);
    assert.equal(tools.some((tool) => tool.name === "bash_run"), false);
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
        async connectInstance(): Promise<JsonValue> {
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
        { workspace: "/workspace" },
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
    assert.deepEqual(harness.audited, [
        {
            context: {
                ctxId: environment.ctxId,
                requestId: "request-environment",
                source: "mcp",
                workspace: "/workspace",
            },
            toolName: "environ_info",
        },
        {
            context: {
                ctxId: environment.ctxId,
                requestId: "request-list",
                source: "mcp",
                workspace: "/workspace",
            },
            toolName: "instance_list",
        },
    ]);
});

test("cached MCP tool names stay callable without re-exposing stale recipients", async () => {
    const harness = createWorker();
    const connected: string[] = [];
    const gateway = {
        assertReady() {},
        async callTool(): Promise<JsonValue> { return {}; },
        async connectInstance(instance: string): Promise<JsonValue> {
            connected.push(instance);
            return { state: "ready" };
        },
        async createSshInstance(): Promise<JsonValue> { return {}; },
        async listInstances(): Promise<JsonValue[]> { return []; },
        listTools: () => [],
        async readTodo(): Promise<JsonValue> { return { items: [], revision: 0 }; },
        async statusInstance(): Promise<JsonValue> { return {}; },
        async stopInstance(): Promise<JsonValue> { return {}; },
        async writeTodo(): Promise<JsonValue> { return {}; },
    } as never;
    const catalog = new McpEndpointCatalog({
        gateway,
        instanceName: "demo-local",
        policy: { capabilities: ["manage"], groups: ["instance"] },
        worker: harness.worker,
    });
    const dispatch = new McpEndpointDispatch({
        catalog,
        gateway,
        instanceName: "demo-local",
        worker: harness.worker,
    });

    assert.equal(catalog.listTools().some((tool) => tool.name === "instance_start"), false);
    assert.equal(catalog.listTools().some((tool) => tool.name === "context_message_read"), false);

    const environment = await dispatch.callTool(
        "environ_info",
        { workspace: "/workspace" },
        { principal: "tester", requestId: "request-environment" },
    ) as { ctxId: string };
    assert.deepEqual(await dispatch.callTool(
        "instance_start",
        { ctxId: environment.ctxId, instance: "remote" },
        { principal: "tester", requestId: "request-start" },
    ), { state: "ready" });
    assert.deepEqual(connected, ["remote"]);

    const tombstone = await dispatch.callTool(
        "context_message_read",
        {},
        { principal: "tester", requestId: "request-stale" },
    );
    assert.ok(tombstone instanceof McpNativeToolResult);
    assert.deepEqual(tombstone.structuredContent, {
        staleToolSnapshot: {
            assistantInstruction: "Queued user Comments are delivered automatically with the next successful ordinary tool result. Do not poll for them.",
            help: "Queued user Comments are delivered automatically with the next successful ordinary tool result. Do not poll for them.",
            name: "context_message_read",
            removedIn: "0.5.1",
        },
    });
    await assert.rejects(
        dispatch.callTool("unknown_cached_tool", {}, { principal: "tester", requestId: "request-unknown" }),
    );
});

test("legacy aliases still obey the current MCP policy", async () => {
    const harness = createWorker();
    const gateway = {
        listTools: () => [],
    } as never;
    const catalog = new McpEndpointCatalog({
        gateway,
        instanceName: "demo-local",
        policy: { capabilities: [], groups: [] },
        worker: harness.worker,
    });
    const dispatch = new McpEndpointDispatch({
        catalog,
        gateway,
        instanceName: "demo-local",
        worker: harness.worker,
    });

    await assert.rejects(
        dispatch.callTool(
            "instance_start",
            { ctxId: "ctx-cached", instance: "remote" },
            { principal: "tester", requestId: "request-start" },
        ),
        /not exposed/i,
    );
});

test("tmux_wait detaches and resumes one durable wait without starting another worker wait", async () => {
    let finishWorker!: (result: JsonValue) => void;
    const workerResult = new Promise<JsonValue>((resolve) => {
        finishWorker = resolve;
    });
    let workerWaitCalls = 0;
    const harness = createWorker({ tools: [tmuxWaitTool()] });
    const worker = {
        ...harness.worker,
        async callTool(toolName: string): Promise<JsonValue> {
            assert.equal(toolName, "tmux_wait");
            workerWaitCalls += 1;
            return await workerResult;
        },
    };
    type Wait = {
        createdAt: string;
        createdByCtxId: string;
        detachedAt?: string;
        kind: "tmux";
        ownerCallId?: string;
        result?: JsonValue;
        status: "waiting" | "detached" | "resolved" | "consumed" | "cancelled";
        taskId?: string;
        targetId: string;
        updatedAt: string;
        waitId: string;
    };
    const waits: Wait[] = [];
    const pending = new Map<string, { reject(error: Error): void; resolve(wait: Wait): void }>();
    const update = (waitId: string, status: Wait["status"], result?: JsonValue): Wait => {
        const wait = waits.find((entry) => entry.waitId === waitId);
        if (wait === undefined) throw new Error(`missing wait ${waitId}`);
        Object.assign(wait, {
            ...(status === "detached" ? { detachedAt: new Date().toISOString() } : {}),
            ...(result === undefined ? {} : { result }),
            status,
            updatedAt: new Date().toISOString(),
        });
        const waiter = pending.get(waitId);
        if (waiter !== undefined) {
            pending.delete(waitId);
            if (status === "resolved") waiter.resolve(wait);
            if (status === "detached" || status === "cancelled") {
                waiter.reject(new Error(`Wait ${waitId} became ${status}.`));
            }
        }
        return wait;
    };
    const gateway = {
        async cancelWait(_instance: string, waitId: string) { return update(waitId, "cancelled"); },
        async consumeWait(_instance: string, waitId: string) { return update(waitId, "consumed"); },
        async createWait(_instance: string, input: { createdByCtxId: string; kind: "tmux"; ownerCallId?: string; taskId?: string; targetId: string }) {
            const now = new Date().toISOString();
            const wait: Wait = {
                ...input,
                createdAt: now,
                status: "waiting",
                updatedAt: now,
                waitId: `wait-${waits.length + 1}`,
            };
            waits.push(wait);
            return wait;
        },
        async decideApproval() { throw new Error("unused"); },
        async detachWait(_instance: string, waitId: string) { return update(waitId, "detached"); },
        async listApprovals() { return []; },
        async listWaits() { return waits; },
        listTools: () => [],
        async readTodo() {
            return {
                items: [],
                revision: 0,
                tasks: [{ ctxId: environment.ctxId, status: "in_progress", taskId: "todo-task-1" }],
            };
        },
        async resolveWait(_instance: string, waitId: string, result?: JsonValue) { return update(waitId, "resolved", result); },
        async waitForWait(_instance: string, waitId: string): Promise<Wait> {
            const wait = waits.find((entry) => entry.waitId === waitId);
            if (wait === undefined) throw new Error(`missing wait ${waitId}`);
            if (wait.status === "resolved") return wait;
            if (wait.status !== "waiting" && wait.status !== "detached") {
                throw new Error(`cannot wait while ${wait.status}`);
            }
            return await new Promise<Wait>((resolve, reject) => pending.set(waitId, { reject, resolve }));
        },
    } as never;
    const catalog = new McpEndpointCatalog({
        gateway,
        instanceName: "demo-local",
        policy: { capabilities: ["read"], groups: ["tmux"] },
        worker,
    });
    const dispatch = new McpEndpointDispatch({ catalog, gateway, instanceName: "demo-local", worker });
    const environment = await dispatch.callTool(
        "environ_info",
        { workspace: "/workspace" },
        { principal: "tester", requestId: "request-environment" },
    ) as { ctxId: string };
    const abort = new AbortController();
    const first = dispatch.callTool(
        "tmux_wait",
        { ctxId: environment.ctxId, task: "task-1" },
        { principal: "tester", requestId: "wait-1" },
        abort.signal,
    );
    await waitUntil(() => waits.length === 1 && workerWaitCalls === 1);
    assert.equal(waits[0]?.taskId, "todo-task-1");
    abort.abort("host remount");
    await assert.rejects(first, /cancelled by the client/u);
    assert.equal(waits[0]?.status, "detached");

    const resumed = dispatch.callTool(
        "tmux_wait",
        { ctxId: environment.ctxId, task: "task-1" },
        { principal: "tester", requestId: "wait-2" },
    );
    await waitUntil(() => workerWaitCalls === 1);
    assert.equal(waits.length, 1);
    assert.equal(workerWaitCalls, 1);

    finishWorker({ task: { id: "task-1", status: "0" } });
    assert.deepEqual(await resumed, { task: { id: "task-1", status: "0" } });
    assert.equal(waits[0]?.status, "consumed");
});

test("environ_info rolls back an undisclosed Context when post-create event recording fails", async () => {
    const harness = createWorker({ failToolCalled: true });
    const registry = new McpContextRegistry({ idFactory: () => "ctx-rollback" });
    const catalog = new McpEndpointCatalog({
        instanceName: "demo-local",
        policy: { capabilities: ["read"], groups: ["file"] },
        worker: harness.worker,
    });
    const dispatch = new McpEndpointDispatch({
        catalog,
        contextRegistry: registry,
        instanceName: "demo-local",
        worker: harness.worker,
    });

    await assert.rejects(
        dispatch.callTool(
            "environ_info",
            { workspace: "/projects/rollback" },
            { principal: "tester", requestId: "request-rollback" },
        ),
        /tool event failed/u,
    );

    assert.deepEqual(await registry.list(), []);
    assert.deepEqual(harness.releasedAlerts, ["/projects/rollback"]);
});

test("environ_info rollback keeps alerts leased by another Context attachment", async () => {
    const harness = createWorker({ failToolCalled: true });
    const ids = ["ctx-existing", "ctx-rollback"];
    const registry = new McpContextRegistry({ idFactory: () => ids.shift()! });
    const existing = await registry.create({
        instance: "origin",
        principal: "tester",
        workspace: "/projects/origin"
    });
    await registry.attachEnvironment(existing.ctxId, {
        instance: "demo-local",
        workspace: "/projects/rollback"
    });
    const catalog = new McpEndpointCatalog({
        instanceName: "demo-local",
        policy: { capabilities: ["read"], groups: ["file"] },
        worker: harness.worker,
    });
    const dispatch = new McpEndpointDispatch({
        catalog,
        contextRegistry: registry,
        instanceName: "demo-local",
        worker: harness.worker,
    });

    await assert.rejects(
        dispatch.callTool(
            "environ_info",
            { workspace: "/projects/rollback" },
            { principal: "tester", requestId: "request-rollback" },
        ),
        /tool event failed/u,
    );

    assert.deepEqual((await registry.list()).map(({ ctxId }) => ctxId), [existing.ctxId]);
    assert.deepEqual(harness.releasedAlerts, []);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out waiting for test state");
}
