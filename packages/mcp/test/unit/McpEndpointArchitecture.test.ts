import assert from "node:assert/strict";
import test from "node:test";

import type {
    GoalActivityKind,
    JsonValue,
    ToolCallContext,
    ToolDefinition,
    WaitRecord
} from "@portable-devshell/shared";

import { McpEndpointCatalog } from "../../src/endpoint/McpEndpointCatalog.ts";
import { McpEndpointDispatch } from "../../src/endpoint/McpEndpointDispatch.ts";
import { McpNativeToolResult } from "../../src/endpoint/McpEndpointResult.ts";
import { McpContextRegistry } from "../../src/context/McpContextRegistry.ts";
import { createMcpContextSelector } from "../../src/context/McpContextSelector.ts";

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

function tmuxRunBlockTool(): ToolDefinition {
    return {
        description: "Run a managed tmux task.",
        group: "tmux",
        inputSchema: {
            additionalProperties: false,
            properties: {
                command: { type: "string" },
                timeout: { type: "integer" },
                wait: { type: "string" },
            },
            required: ["command"],
            type: "object",
        },
        name: "tmux_run",
        outputSchema: { type: "object" },
        requiredCapabilities: ["read"],
    };
}

function tmuxReadBlockTool(): ToolDefinition {
    return {
        description: "Read a managed tmux task.",
        group: "tmux",
        inputSchema: {
            additionalProperties: false,
            properties: {
                line: { type: "integer" },
                task: { type: "string" },
                timeMs: { type: "integer" },
            },
            required: ["task"],
            type: "object",
        },
        name: "tmux_read",
        outputSchema: { type: "object" },
        requiredCapabilities: ["read"],
    };
}

function createWorker(options: {
    cached?: boolean;
    failAuditAfterOperation?: boolean;
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
    const auditResults: Array<{ result: JsonValue; toolName: string }> = [];
    const releasedAlerts: string[] = [];
    const worker = {
        async auditToolCall<T extends JsonValue>(
            toolName: string,
            _input: JsonValue,
            context: ToolCallContext,
            operation: (callId: string) => Promise<T>
        ): Promise<T> {
            audited.push({ context, toolName });
            const result = await operation("call-test");
            auditResults.push({ result, toolName });
            if (options.failAuditAfterOperation === true) throw new Error("audit finalize failed");
            return result;
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
                projectMemoryPresent: true,
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
    return { audited, auditResults, calls, events, releasedAlerts, worker };
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
    const recoverableWaits: WaitRecord[] = [];
    const dismissedRecoveries: string[] = [];
    const contextRegistry = new McpContextRegistry();
    const gateway = {
        assertReady() {},
        async callTool(): Promise<JsonValue> {
            return { remote: true };
        },
        async createSshInstance(): Promise<JsonValue> {
            return { created: true };
        },
        async createWait(): Promise<WaitRecord> { throw new Error("unused"); },
        async detachWait(): Promise<WaitRecord> { throw new Error("unused"); },
        async consumeWait(_instance: string, waitId: string): Promise<WaitRecord> {
            const wait = recoverableWaits.find((entry) => entry.waitId === waitId);
            if (wait === undefined) throw new Error(`wait ${waitId} missing`);
            wait.status = "consumed";
            wait.consumedAt = new Date().toISOString();
            return { ...wait };
        },
        async resolveWait(): Promise<WaitRecord> { throw new Error("unused"); },
        async waitForWait(): Promise<WaitRecord> { throw new Error("unused"); },
        async listWaits(): Promise<WaitRecord[]> { return recoverableWaits.map((wait) => ({ ...wait })); },
        async listApprovals() { return []; },
        async decideApproval() { throw new Error("unused"); },
        async claimWaitRecovery(): Promise<WaitRecord> { throw new Error("unused"); },
        async completeWaitRecovery(): Promise<WaitRecord> { throw new Error("unused"); },
        async markWaitRecoveryAttempted(): Promise<WaitRecord> { throw new Error("unused"); },
        async releaseWaitRecovery(): Promise<WaitRecord> { throw new Error("unused"); },
        async dismissWaitRecovery(_instance: string, waitId: string): Promise<WaitRecord> {
            dismissedRecoveries.push(waitId);
            const wait = recoverableWaits.find((entry) => entry.waitId === waitId);
            if (wait === undefined) throw new Error("wait missing");
            if (waitId === "wait-recovery-raced") throw new Error("already consumed by sibling Workspace App");
            wait.status = "consumed";
            return { ...wait };
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
        contextRegistry,
        gateway,
        instanceName: "demo-local",
        worker: harness.worker
    });

    const environment = structuredResult<{ ctxId: string; workspace: string }>(await dispatch.callTool(
        "environ_info",
        { workspace: "/workspace" },
        { principal: "tester", requestId: "request-environment" }
    ));
    assert.equal(environment.workspace, "/workspace");
    assert.equal(typeof environment.ctxId, "string");
    await contextRegistry.suppressAutomaticReentry(environment.ctxId, "demo-local", "user interrupted", "user_owned");

    const listed = await dispatch.callTool(
        "instance_list",
        { ctxId: environment.ctxId },
        { principal: "tester", requestId: "request-list" }
    );
    assert.deepEqual(listed, { instances: [{ name: "demo-local" }] });
    assert.equal((await contextRegistry.readAutomaticReentry(environment.ctxId, "demo-local")).mode, "user_owned");

    recoverableWaits.push({
        createdAt: "2026-08-30T00:00:00.000Z",
        createdByCtxId: environment.ctxId,
        detachedAt: "2026-08-30T00:00:01.000Z",
        kind: "tmux",
        recoveryMessageAttemptedAt: "2026-08-30T00:00:02.000Z",
        recoveryMessageId: "resume-message-1",
        status: "resolved",
        targetId: "tmux-task-1",
        updatedAt: "2026-08-30T00:00:02.000Z",
        waitId: "wait-recovery-1",
    });
    recoverableWaits.push({
        createdAt: "2026-08-30T00:00:00.000Z",
        createdByCtxId: environment.ctxId,
        detachedAt: "2026-08-30T00:00:01.000Z",
        kind: "tmux",
        recoveryMessageAttemptedAt: "2026-08-30T00:00:02.000Z",
        recoveryMessageId: "resume-message-raced",
        status: "resolved",
        targetId: "tmux-task-raced",
        updatedAt: "2026-08-30T00:00:02.000Z",
        waitId: "wait-recovery-raced",
    });

    const workerResult = await dispatch.callTool(
        "bash_run",
        { command: "pwd", ctxId: environment.ctxId },
        { principal: "tester", requestId: "request-worker" }
    );
    assert.deepEqual(workerResult, { ok: true, toolName: "bash_run" });
    assert.equal((await contextRegistry.readAutomaticReentry(environment.ctxId, "demo-local")).mode, "automatic");
    assert.equal(recoverableWaits.find((entry) => entry.waitId === "wait-recovery-1")?.status, "resolved");
    assert.equal(recoverableWaits.find((entry) => entry.waitId === "wait-recovery-raced")?.status, "resolved");
    assert.deepEqual(
        dismissedRecoveries,
        [],
        "ordinary Agent activity must not guess which ambiguous recovery message the host accepted",
    );
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

    const environment = structuredResult<{ ctxId: string }>(await dispatch.callTool(
        "environ_info",
        { workspace: "/workspace" },
        { principal: "tester", requestId: "request-environment" },
    ));
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

test("Workspace authorization metadata never enters audit results or MCP events", async () => {
    const harness = createWorker({ tools: [] });
    const unused = async () => { throw new Error("unused"); };
    const gateway = {
        consumeWait: unused,
        createWait: unused,
        decideApproval: unused,
        detachWait: unused,
        listApprovals: async () => [],
        listTools: () => [],
        listWaits: async () => [],
        resolveWait: unused,
        waitForWait: unused,
    } as never;
    const catalog = new McpEndpointCatalog({
        gateway,
        instanceName: "demo-local",
        policy: { capabilities: [], groups: ["workspace"] },
        worker: harness.worker,
    });
    const dispatch = new McpEndpointDispatch({ catalog, gateway, instanceName: "demo-local", worker: harness.worker });
    const environment = await dispatch.callTool(
        "environ_info",
        { workspace: "/workspace" },
        { principal: "tester", requestId: "workspace-environment" },
    );
    assert.ok(environment instanceof McpNativeToolResult);
    const environmentState = environment.structuredContent as { ctxId: string };
    const token = (environment._meta?.["portable-devshell/workspace"] as { token?: string } | undefined)?.token;
    if (typeof token !== "string") throw new Error("workspace token missing");
    assert.equal(JSON.stringify(environment.structuredContent).includes(token), false);
    const environmentAudit = harness.auditResults.find((entry) => entry.toolName === "environ_info");
    assert.notEqual(environmentAudit, undefined);
    assert.equal(JSON.stringify(environmentAudit?.result).includes(token), false);

    const opened = await dispatch.callTool(
        "workspace_open",
        { ctxId: environmentState.ctxId },
        { principal: "tester", requestId: "workspace-open" },
    );
    assert.ok(opened instanceof McpNativeToolResult);
    const reopenedToken = (opened._meta?.["portable-devshell/workspace"] as { token?: string } | undefined)?.token;
    assert.equal(reopenedToken, token);
    assert.equal(JSON.stringify(opened.structuredContent).includes(token), false);
    const workspaceAudit = harness.auditResults.find((entry) => entry.toolName === "workspace_open");
    assert.notEqual(workspaceAudit, undefined);
    assert.equal(JSON.stringify(workspaceAudit?.result).includes(token), false);
    assert.equal(JSON.stringify(harness.events).includes(token), false);
});

test("v0.6.15 Workspace wire calls stay hidden but dispatch through the current Workspace policy", async () => {
    const harness = createWorker({ tools: [] });
    const unused = async () => { throw new Error("unused"); };
    const gateway = {
        consumeWait: unused,
        createWait: unused,
        decideApproval: unused,
        detachWait: unused,
        listApprovals: async () => [],
        listTools: () => [],
        listWaits: async () => [],
        resolveWait: unused,
        waitForWait: unused,
    } as never;
    const catalog = new McpEndpointCatalog({
        gateway,
        instanceName: "demo-local",
        policy: { capabilities: [], groups: ["workspace"] },
        worker: harness.worker,
    });
    const dispatch = new McpEndpointDispatch({ catalog, gateway, instanceName: "demo-local", worker: harness.worker });
    const environment = await dispatch.callTool(
        "environ_info",
        { workspace: "/workspace" },
        { principal: "tester", requestId: "workspace-legacy-environment" },
    );
    assert.ok(environment instanceof McpNativeToolResult);
    const ctxId = (environment.structuredContent as { ctxId?: string }).ctxId;
    const token = (environment._meta?.["portable-devshell/workspace"] as { token?: string } | undefined)?.token;
    if (typeof ctxId !== "string" || typeof token !== "string") throw new Error("workspace bootstrap missing");

    const result = await dispatch.callTool(
        "workspace_reentry_control",
        { action: "get", ctxId, token },
        { principal: "tester", requestId: "workspace-legacy-reentry" },
    ) as { mode?: string };
    assert.equal(result.mode, "automatic");
    assert.equal(catalog.snapshot().merged.some((entry) => entry.definition.name === "workspace_reentry_control"), false);
    assert.equal(catalog.snapshot().exposed.some((entry) => entry.definition.name === "workspace_reentry_control"), false);
});

test("OpenAI session resolves Workspace once and the App continues by ctxId without session metadata", async () => {
    const harness = createWorker({ tools: [] });
    const unused = async () => {
        throw new Error("unused");
    };
    const gateway = {
        consumeWait: unused,
        createWait: unused,
        decideApproval: unused,
        detachWait: unused,
        listApprovals: async () => [],
        listTools: () => [],
        listWaits: async () => [],
        async readTodo() {
            return {
                items: [],
                revision: 0,
                summary: { completed: 0, total: 0 },
                tasks: [],
            };
        },
        async readToolCalls() {
            return [];
        },
        async readWorkspaceEvents() {
            return { events: [], gap: false, lastSeq: 0 };
        },
        resolveWait: unused,
        waitForWait: unused,
    } as never;
    let now = 1_000;
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-workspace-session",
        now: () => now,
        ttlMs: 100,
    });
    await registry.initialize();
    const contextSelector = createMcpContextSelector("openai-session");
    const catalog = new McpEndpointCatalog({
        contextSelector,
        gateway,
        instanceName: "demo-local",
        policy: { capabilities: [], groups: ["workspace"] },
        worker: harness.worker,
    });
    const dispatch = new McpEndpointDispatch({
        catalog,
        contextRegistry: registry,
        contextSelector,
        gateway,
        instanceName: "demo-local",
        worker: harness.worker,
    });
    const sessionContext = {
        principal: "tester",
        requestId: "workspace-session-acquire",
        requestMeta: { "openai/session": "openai-workspace-session" },
    };

    const acquired = structuredResult<{ ctxId: string }>(await dispatch.callTool(
        "environ_info",
        { workspace: "/workspace" },
        sessionContext,
    ));
    assert.equal(acquired.ctxId, "ctx-workspace-session");

    const opened = await dispatch.callTool(
        "workspace_open",
        {},
        { ...sessionContext, requestId: "workspace-session-open" },
    );
    assert.ok(opened instanceof McpNativeToolResult);
    assert.equal(
        (opened.structuredContent as { ctxId?: string }).ctxId,
        acquired.ctxId,
    );
    const token = (
        opened._meta?.["portable-devshell/workspace"] as
            { token?: string } | undefined
    )?.token;
    if (typeof token !== "string") throw new Error("workspace token missing");
    const beforeSnapshot = await registry.lookup(acquired.ctxId, { principal: "tester" });
    now += 50;

    const snapshot = await dispatch.callTool(
        "workspace_snapshot",
        { ctxId: acquired.ctxId, token },
        { principal: "tester", requestId: "workspace-app-snapshot" },
    );
    assert.ok(snapshot instanceof McpNativeToolResult);
    assert.equal(
        (snapshot.structuredContent as { ctxId?: string }).ctxId,
        acquired.ctxId,
    );
    const afterSnapshot = await registry.lookup(acquired.ctxId, { principal: "tester" });
    assert.equal(afterSnapshot.expiresAt, beforeSnapshot.expiresAt);
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

test("tmux_run block waits are interruptible before handoff and detach after the sync window", async () => {
    let concurrentAgentCall = false;
    let observeCalls = 0;
    let runCalls = 0;
    const excludedCallIds: Array<string | undefined> = [];
    const terminalResults = new Map<string, JsonValue>();
    const harness = createWorker({ tools: [tmuxRunBlockTool()] });
    const worker = {
        ...harness.worker,
        async invokeToolInternal(toolName: string, input: JsonValue): Promise<JsonValue> {
            assert.equal(toolName, "tmux_read");
            const task = (input as { task?: string }).task;
            if (task === undefined) throw new Error("tmux_read task is missing");
            return terminalResults.get(task) ?? { task: { id: task, status: "running" } };
        },
        async callTool(
            toolName: string,
            input: JsonValue,
            _context?: ToolCallContext,
            _signal?: AbortSignal,
            transformResult?: (result: JsonValue, callId: string) => Promise<JsonValue>,
            invocationInput?: JsonValue,
        ): Promise<JsonValue> {
            assert.equal(toolName, "tmux_run");
            assert.deepEqual(input, {
                command: "sleep 10",
                timeout: 660_000,
                wait: "block",
            });
            assert.deepEqual(invocationInput, {
                command: "sleep 10",
                consumeOutput: false,
                timeout: 660_000,
                wait: "nonblock",
            });
            runCalls += 1;
            const result = { task: { id: `task-${runCalls}`, status: "running" } } as JsonValue;
            return transformResult === undefined ? result : await transformResult(result, `call-tmux-run-${runCalls}`);
        },
    };
    type Wait = {
        automaticRecovery?: boolean;
        createdAt: string;
        createdByCtxId: string;
        detachedAt?: string;
        kind: "tmux";
        ownerCallId?: string;
        payload?: JsonValue;
        result?: JsonValue;
        status: "waiting" | "detached" | "resolved" | "consumed" | "cancelled";
        taskId?: string;
        targetId: string;
        deadlineAt?: string;
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
        async createWait(_instance: string, input: { automaticRecovery?: boolean; createdByCtxId: string; kind: "tmux"; ownerCallId?: string; payload?: JsonValue; taskId?: string; targetId: string }) {
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
        hasActiveToolCalls(_instance: string, ctxId: string, excludeCallId?: string) {
            assert.equal(ctxId, environment.ctxId);
            excludedCallIds.push(excludeCallId);
            return concurrentAgentCall;
        },
        async listApprovals() { return []; },
        async listWaits() { return waits; },
        listTools: () => [],
        async observeTmuxTask(_instance: string, taskId: string) {
            observeCalls += 1;
            return terminalResults.get(taskId) ?? { task: { id: taskId, status: "running" } };
        },
        async reattachWait(_instance: string, waitId: string, ownerCallId?: string) {
            const wait = waits.find((entry) => entry.waitId === waitId);
            if (wait === undefined || wait.status !== "detached") throw new Error(`cannot reattach ${waitId}`);
            delete wait.detachedAt;
            wait.status = "waiting";
            wait.updatedAt = new Date().toISOString();
            if (ownerCallId === undefined) delete wait.ownerCallId;
            else wait.ownerCallId = ownerCallId;
            return wait;
        },
        async readTodo(_instance: string, input?: { taskId?: string }) {
            if (input?.taskId === "todo-task-1") {
                return {
                    items: [{ content: "Wait for tmux", id: "item-1", status: "in_progress" }],
                    revision: 1,
                    taskId: "todo-task-1",
                    tasks: [{ ctxId: environment.ctxId, status: "in_progress", taskId: "todo-task-1" }],
                };
            }
            return {
                items: [],
                revision: 0,
                tasks: [{ ctxId: environment.ctxId, status: "in_progress", taskId: "todo-task-1" }],
            };
        },
        async resolveWait(
            _instance: string,
            waitId: string,
            result?: JsonValue,
            options?: { consumeIfDetached?: boolean },
        ) {
            const wait = waits.find((entry) => entry.waitId === waitId);
            if (wait === undefined) throw new Error(`missing wait ${waitId}`);
            return options?.consumeIfDetached === true && wait.status === "detached"
                ? update(waitId, "consumed", result)
                : update(waitId, "resolved", result);
        },
        async touchGoal() {},
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
        policy: { capabilities: ["read"], groups: ["workspace", "tmux"] },
        worker,
    });
    const contextRegistry = new McpContextRegistry();
    const dispatch = new McpEndpointDispatch({
        catalog,
        contextRegistry,
        gateway,
        instanceName: "demo-local",
        tmuxBlockSyncMs: 250,
        tmuxWaitPollMs: 1,
        worker,
    });
    const environment = structuredResult<{ ctxId: string }>(await dispatch.callTool(
        "environ_info",
        { workspace: "/workspace" },
        { principal: "tester", requestId: "request-environment" },
    ));

    const opened = await dispatch.callTool(
        "workspace_open",
        { ctxId: environment.ctxId },
        { principal: "tester", requestId: "workspace-open" },
    );
    assert.ok(opened instanceof McpNativeToolResult);
    const token = (opened._meta?.["portable-devshell/workspace"] as { token?: string } | undefined)?.token;
    if (typeof token !== "string") throw new Error("workspace token missing");

    const interruptible = dispatch.callTool(
        "tmux_run",
        { command: "sleep 10", ctxId: environment.ctxId, timeout: 660_000, wait: "block" },
        { principal: "tester", requestId: "wait-interruptible" },
    ) as Promise<{ interrupted?: boolean; task?: { id?: string; status?: string } }>;
    await waitUntil(() => waits.length === 1 && observeCalls > 0);
    assert.equal(waits[0]?.taskId, "todo-task-1");
    assert.equal(waits[0]?.automaticRecovery, true);
    assert.deepEqual(waits[0]?.payload, { line: 80 });
    assert.equal(waits[0]?.status, "waiting");
    const interrupt = await dispatch.callTool(
        "workspace_interrupt",
        { ctxId: environment.ctxId, token, waitId: waits[0]!.waitId },
        { principal: "tester", requestId: "interrupt-wait" },
    ) as { detached?: boolean; interrupted?: boolean; tmuxTaskId?: string };
    assert.equal(interrupt.interrupted, true);
    assert.equal(interrupt.detached, false);
    assert.equal(interrupt.tmuxTaskId, "task-1");
    const interrupted = await interruptible;
    assert.equal(interrupted.interrupted, true);
    assert.deepEqual(interrupted.task, { id: "task-1", status: "running" });
    assert.equal(waits[0]?.status, "consumed");

    const first = await dispatch.callTool(
        "tmux_run",
        { command: "sleep 10", ctxId: environment.ctxId, timeout: 660_000, wait: "block" },
        { principal: "tester", requestId: "wait-detached" },
    ) as { detached?: boolean; task?: { id?: string; status?: string } };
    await waitUntil(() => waits.length === 2 && observeCalls > 1);
    assert.equal(waits[1]?.taskId, "todo-task-1");
    assert.equal(first.detached, true);
    assert.deepEqual(first.task, { id: "task-2", status: "running" });
    assert.equal(waits[1]?.status, "detached");
    concurrentAgentCall = true;
    terminalResults.set("task-2", { task: { id: "task-2", status: "1" } });
    await waitUntil(() => waits[1]?.status === "consumed");
    assert.equal(waits[1]?.status, "consumed");
    assert.equal(waits[1]?.result, terminalResults.get("task-2"));
    assert.equal(
        excludedCallIds.includes("call-tmux-run-2"),
        false,
        "the Context execution lease suppresses detached completion before the live-call fallback is needed",
    );
    concurrentAgentCall = false;
    assert.equal(runCalls, 2);
    assert.equal(harness.audited.filter((entry) => entry.toolName === "tmux_run").length, 0);
    assert.equal(harness.auditResults.filter((entry) => entry.toolName === "tmux_run").length, 0);

    const restoredNow = new Date().toISOString();
    waits.push({
        createdAt: restoredNow,
        createdByCtxId: environment.ctxId,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        detachedAt: restoredNow,
        kind: "tmux",
        payload: { line: 17 },
        status: "detached",
        targetId: "task-2",
        updatedAt: restoredNow,
        waitId: "wait-restored",
    });
    terminalResults.set("task-2", { task: { id: "task-2", status: "1" } });
    let restoreListCalls = 0;
    const restartedGateway = {
        ...(gateway as unknown as Record<string, unknown>),
        async listWaits() {
            restoreListCalls += 1;
            if (restoreListCalls === 1) throw new Error("temporary wait-store read failure");
            return waits;
        },
    } as never;
    const restartedDispatch = new McpEndpointDispatch({
        catalog,
        contextRegistry: new McpContextRegistry(),
        gateway: restartedGateway,
        instanceName: "demo-local",
        tmuxBlockSyncMs: 250,
        tmuxWaitPollMs: 1,
        worker,
    });
    await restartedDispatch.restoreTmuxWaits();
    assert.equal(waits.find((entry) => entry.waitId === "wait-restored")?.status, "detached");
    await restartedDispatch.restoreTmuxWaits();
    await waitUntil(() => waits.find((entry) => entry.waitId === "wait-restored")?.status === "resolved");
    assert.equal(restoreListCalls, 2);
    assert.equal(waits.find((entry) => entry.waitId === "wait-restored")?.result, terminalResults.get("task-2"));

    terminalResults.delete("task-3");
    const synchronous = dispatch.callTool(
        "tmux_run",
        { command: "sleep 10", ctxId: environment.ctxId, timeout: 660_000, wait: "block" },
        { principal: "tester", requestId: "wait-completes-before-handoff" },
    ) as Promise<{ detached?: boolean; task?: { id?: string; status?: string } }>;
    await waitUntil(() => runCalls === 3 && waits.length === 4);
    terminalResults.set("task-3", { task: { id: "task-3", status: "0" } });
    const synchronousResult = await synchronous;
    assert.equal(synchronousResult.detached, undefined);
    assert.deepEqual(synchronousResult.task, { id: "task-3", status: "0" });
    assert.equal(waits[3]?.status, "consumed");
    assert.equal(waits[3]?.detachedAt, undefined);

    terminalResults.delete("task-4");
    const transportAbort = new AbortController();
    let transportSettled = false;
    const transportInterrupted = dispatch.callTool(
        "tmux_run",
        { command: "sleep 10", ctxId: environment.ctxId, timeout: 660_000, wait: "block" },
        { principal: "tester", requestId: "transport-abort-before-handoff" },
        transportAbort.signal,
    ).then(
        (result) => {
            transportSettled = true;
            return { kind: "resolved" as const, result };
        },
        (error: unknown) => {
            transportSettled = true;
            return { error, kind: "rejected" as const };
        },
    );
    await waitUntil(() => runCalls === 4 && waits.length === 5);
    assert.equal(waits[4]?.status, "waiting");
    transportAbort.abort("transport closed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(transportSettled, true, "transport abort should hand off before the synchronous wait boundary");
    assert.equal(waits[4]?.status, "detached");
    const transportOutcome = await transportInterrupted;
    assert.equal(transportOutcome.kind, "resolved");
    if (transportOutcome.kind === "resolved") {
        const result = transportOutcome.result as { detached?: boolean; task?: { id?: string; status?: string } };
        assert.equal(result.detached, true);
        assert.deepEqual(result.task, { id: "task-4", status: "running" });
    }
    assert.equal(waits[4]?.status, "detached");

    terminalResults.delete("task-5");
    const completionAbort = new AbortController();
    const completesAfterTransportAbort = dispatch.callTool(
        "tmux_run",
        { command: "sleep 10", ctxId: environment.ctxId, timeout: 660_000, wait: "block" },
        { principal: "tester", requestId: "transport-abort-before-completion" },
        completionAbort.signal,
    ) as Promise<{ detached?: boolean; task?: { id?: string; status?: string } }>;
    await waitUntil(() => runCalls === 5 && waits.length === 6);
    completionAbort.abort("transport closed");
    const completedAfterAbort = await completesAfterTransportAbort;
    assert.equal(completedAfterAbort.detached, true);
    assert.deepEqual(completedAfterAbort.task, { id: "task-5", status: "running" });
    assert.equal(waits[5]?.status, "detached");
    assert.equal(typeof waits[5]?.detachedAt, "string");
    terminalResults.set("task-5", { task: { id: "task-5", status: "0" } });
    await waitUntil(() => waits[5]?.status === "resolved");
    assert.equal(waits[5]?.status, "resolved");
    assert.equal(typeof waits[5]?.detachedAt, "string");
    assert.deepEqual(waits[5]?.result, terminalResults.get("task-5"));

    const disabledCatalog = new McpEndpointCatalog({
        gateway,
        instanceName: "demo-local",
        policy: { capabilities: ["read"], groups: ["tmux"] },
        worker,
    });
    const disabledDispatch = new McpEndpointDispatch({
        catalog: disabledCatalog,
        contextRegistry: new McpContextRegistry(),
        gateway,
        instanceName: "demo-local",
        tmuxBlockSyncMs: 250,
        tmuxWaitPollMs: 1,
        worker,
    });
    const disabledEnvironment = structuredResult<{ ctxId: string }>(await disabledDispatch.callTool(
        "environ_info",
        { workspace: "/workspace-disabled" },
        { principal: "tester", requestId: "request-environment-disabled" },
    ));
    const disabledAbort = new AbortController();
    const disabledCall = disabledDispatch.callTool(
        "tmux_run",
        { command: "sleep 10", ctxId: disabledEnvironment.ctxId, timeout: 660_000, wait: "block" },
        { principal: "tester", requestId: "wait-disabled-workspace" },
        disabledAbort.signal,
    ) as Promise<{ detached?: boolean }>;
    await waitUntil(() => runCalls === 6 && waits.length === 7);
    disabledAbort.abort("transport closed");
    const disabledResult = await disabledCall;
    assert.equal(disabledResult.detached, true);
    assert.equal(waits.at(-1)?.automaticRecovery, false);
});

test("tmux_read long waits detach into durable Workspace state", async () => {
    let concurrentAgentCall = false;
    let ready = false;
    let internalReadCalls = 0;
    let logicalReadCalls = 0;
    const goalActivityKinds: GoalActivityKind[] = [];
    const harness = createWorker({ tools: [tmuxReadBlockTool()] });
    const worker = {
        ...harness.worker,
        async invokeToolInternal(toolName: string, input: JsonValue): Promise<JsonValue> {
            assert.equal(toolName, "tmux_read");
            internalReadCalls += 1;
            return await readTmux(input);
        },
        async callTool(
            toolName: string,
            input: JsonValue,
            _context?: ToolCallContext,
            _signal?: AbortSignal,
            transformResult?: (result: JsonValue, callId: string) => Promise<JsonValue>,
            invocationInput?: JsonValue,
        ): Promise<JsonValue> {
            assert.equal(toolName, "tmux_read");
            logicalReadCalls += 1;
            const result = await readTmux(invocationInput ?? input);
            return transformResult === undefined ? result : await transformResult(result, "call-tmux-read");
        },
    };
    const readTmux = async (input: JsonValue): Promise<JsonValue> => {
            const record = input as Record<string, JsonValue>;
            assert.equal(record.task, "task-existing");
            let result: JsonValue;
            if (record.consumeOutput === false) {
                const timeMs = typeof record.timeMs === "number" ? record.timeMs : 0;
                if (timeMs > 0) await new Promise((resolve) => setTimeout(resolve, timeMs));
                result = {
                    task: { id: "task-existing", status: "running" },
                    waitReason: ready ? "output" : "timeout",
                };
            } else {
                result = {
                    task: { id: "task-existing", status: "running" },
                    waitReason: "output",
                };
            }
            return result;
    };
    type Wait = WaitRecord;
    const waits: Wait[] = [];
    const pending = new Map<string, { reject(error: Error): void; resolve(wait: Wait): void }>();
    const update = (waitId: string, status: Wait["status"], result?: JsonValue): Wait => {
        const wait = waits.find((entry) => entry.waitId === waitId);
        if (wait === undefined) throw new Error(`missing wait ${waitId}`);
        Object.assign(wait, {
            ...(status === "detached" ? { detachedAt: new Date().toISOString() } : {}),
            ...(result === undefined ? {} : { result }),
            ...(status === "resolved" ? { resolvedAt: new Date().toISOString() } : {}),
            status,
            updatedAt: new Date().toISOString(),
        });
        const waiter = pending.get(waitId);
        if (waiter !== undefined) {
            pending.delete(waitId);
            if (status === "resolved") waiter.resolve(wait);
            if (status === "detached" || status === "cancelled") waiter.reject(new Error(`Wait ${waitId} became ${status}.`));
        }
        return wait;
    };
    const gateway = {
        async cancelWait(_instance: string, waitId: string) { return update(waitId, "cancelled"); },
        async consumeWait(_instance: string, waitId: string) { return update(waitId, "consumed"); },
        async createWait(_instance: string, input: import("@portable-devshell/shared").WaitCreateInput) {
            const now = new Date().toISOString();
            const wait = { ...input, createdAt: now, status: "waiting" as const, updatedAt: now, waitId: `wait-read-${waits.length + 1}` };
            waits.push(wait);
            return wait;
        },
        async decideApproval() { throw new Error("unused"); },
        async detachWait(_instance: string, waitId: string) { return update(waitId, "detached"); },
        hasActiveToolCalls(_instance: string, ctxId: string, excludeCallId?: string) {
            assert.equal(ctxId, environment.ctxId);
            assert.equal(excludeCallId, "call-tmux-read");
            return concurrentAgentCall;
        },
        async listApprovals() { return []; },
        async listWaits() { return waits; },
        listTools: () => [],
        async observeTmuxTask(_instance: string, taskId: string) { return { task: { id: taskId, status: "running" } }; },
        async readTodo() { return { items: [], revision: 0, tasks: [] }; },
        async reattachWait(_instance: string, waitId: string) { return update(waitId, "waiting"); },
        async resolveWait(
            _instance: string,
            waitId: string,
            result?: JsonValue,
            options?: { consumeIfDetached?: boolean },
        ) {
            const wait = waits.find((entry) => entry.waitId === waitId);
            if (wait === undefined) throw new Error(`missing wait ${waitId}`);
            return options?.consumeIfDetached === true && wait.status === "detached"
                ? update(waitId, "consumed", result)
                : update(waitId, "resolved", result);
        },
        async touchGoal(_instance: string, _ctxId: string, kind: GoalActivityKind = "execution") { goalActivityKinds.push(kind); },
        async waitForWait(_instance: string, waitId: string): Promise<Wait> {
            const wait = waits.find((entry) => entry.waitId === waitId);
            if (wait === undefined) throw new Error(`missing wait ${waitId}`);
            if (wait.status === "resolved") return wait;
            return await new Promise<Wait>((resolve, reject) => pending.set(waitId, { reject, resolve }));
        },
    } as never;
    const catalog = new McpEndpointCatalog({
        gateway,
        instanceName: "demo-local",
        policy: { capabilities: ["read"], groups: ["tmux"] },
        worker,
    });
    let executionNow = Date.now();
    const contextRegistry = new McpContextRegistry({ now: () => executionNow });
    const dispatch = new McpEndpointDispatch({
        catalog,
        contextRegistry,
        gateway,
        instanceName: "demo-local",
        tmuxBlockSyncMs: 20,
        tmuxWaitPollMs: 1,
        worker,
    });
    const environment = structuredResult<{ ctxId: string }>(await dispatch.callTool(
        "environ_info",
        { workspace: "/workspace" },
        { principal: "tester", requestId: "request-environment-read" },
    ));

    const observedNow = new Date().toISOString();
    waits.push({
        createdAt: observedNow,
        createdByCtxId: environment.ctxId,
        detachedAt: observedNow,
        kind: "tmux",
        recoveryMessageAttemptedAt: observedNow,
        recoveryMessageId: "recovery-observed",
        resolvedAt: observedNow,
        result: { task: { id: "task-existing", status: "running" }, timedOut: true },
        status: "resolved",
        targetId: "task-existing",
        targetInstance: "demo-local",
        updatedAt: observedNow,
        waitId: "wait-observed",
    });
    await dispatch.callTool(
        "tmux_read",
        { ctxId: environment.ctxId, line: 17, task: "task-existing", timeMs: 0 },
        { principal: "tester", requestId: "read-observed-wait" },
    );
    assert.equal(waits.find((entry) => entry.waitId === "wait-observed")?.status, "consumed");
    assert.equal(
        waits.find((entry) => entry.waitId === "wait-observed")?.recoveryMessageAttemptedAt,
        observedNow,
        "a precise same-task observation settles an uncertain wake without replaying it",
    );
    assert.deepEqual(goalActivityKinds.slice(-2), ["observation", "observation"]);

    const pendingNow = new Date().toISOString();
    waits.push({
        createdAt: pendingNow,
        createdByCtxId: environment.ctxId,
        detachedAt: pendingNow,
        kind: "tmux",
        status: "detached",
        targetId: "task-existing",
        targetInstance: "demo-local",
        updatedAt: pendingNow,
        waitId: "wait-older-detached",
    });
    await dispatch.callTool(
        "tmux_read",
        { ctxId: environment.ctxId, line: 17, task: "task-existing", timeMs: 0 },
        { principal: "tester", requestId: "read-running-task" },
    );
    assert.equal(waits.find((entry) => entry.waitId === "wait-older-detached")?.status, "detached");

    const logicalReadsBeforeWait = logicalReadCalls;
    const internalReadsBeforeWait = internalReadCalls;
    const result = await dispatch.callTool(
        "tmux_read",
        { ctxId: environment.ctxId, line: 17, task: "task-existing", timeMs: 1_000 },
        { principal: "tester", requestId: "wait-read-detached" },
    ) as { detached?: boolean };
    assert.equal(result.detached, true);
    assert.deepEqual(goalActivityKinds.slice(-2), ["wait", "wait"]);
    assert.equal(waits.find((entry) => entry.waitId === "wait-older-detached")?.status, "cancelled");
    const replacement = waits.find((entry) => entry.waitId.startsWith("wait-read-"));
    assert.equal(replacement?.status, "detached");
    assert.equal(replacement?.targetId, "task-existing");
    assert.equal(replacement?.targetInstance, "demo-local");
    assert.deepEqual(replacement?.payload, { line: 17, operation: "read" });
    assert.equal(logicalReadCalls - logicalReadsBeforeWait, 1);
    assert.equal(internalReadCalls > internalReadsBeforeWait, true);

    concurrentAgentCall = true;
    ready = true;
    await waitUntil(() => replacement?.status === "consumed");
    assert.equal(replacement?.status, "consumed");

    concurrentAgentCall = false;
    ready = false;
    const idleResult = await dispatch.callTool(
        "tmux_read",
        { ctxId: environment.ctxId, line: 17, task: "task-existing", timeMs: 1_000 },
        { principal: "tester", requestId: "wait-read-idle" },
    ) as { detached?: boolean };
    assert.equal(idleResult.detached, true);
    const idleReplacement = waits.filter((entry) => entry.waitId.startsWith("wait-read-")).at(-1);
    assert.equal(idleReplacement?.status, "detached");
    executionNow += 60_001;
    ready = true;
    await waitUntil(() => idleReplacement?.status === "resolved");
    assert.equal(idleReplacement?.status, "resolved");

    ready = false;
    const abortDispatch = new McpEndpointDispatch({
        catalog,
        contextRegistry,
        gateway,
        instanceName: "demo-local",
        tmuxBlockSyncMs: 250,
        tmuxWaitPollMs: 1,
        worker,
    });
    const waitCountBeforeAbort = waits.length;
    const transportAbort = new AbortController();
    let transportSettled = false;
    const abortedRead = abortDispatch.callTool(
        "tmux_read",
        { ctxId: environment.ctxId, line: 17, task: "task-existing", timeMs: 1_000 },
        { principal: "tester", requestId: "wait-read-transport-abort" },
        transportAbort.signal,
    ).then((value) => {
        transportSettled = true;
        return value as { detached?: boolean };
    });
    await waitUntil(() => waits.length === waitCountBeforeAbort + 1);
    const abortedReplacement = waits.at(-1);
    assert.equal(abortedReplacement?.status, "waiting");
    transportAbort.abort("transport closed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(transportSettled, true, "tmux_read transport abort should hand off before the wait boundary");
    assert.equal((await abortedRead).detached, true);
    assert.equal(abortedReplacement?.status, "detached");
    assert.equal(typeof abortedReplacement?.detachedAt, "string");

    ready = true;
    await waitUntil(() => abortedReplacement?.status === "resolved");
    assert.equal(abortedReplacement?.status, "resolved");
    assert.equal(typeof abortedReplacement?.detachedAt, "string");
});

test("failed environ_info rolls back only the undisclosed explicit Context", async () => {
    const ids = ["ctx-session-old", "ctx-session-new"];
    const registry = new McpContextRegistry({ idFactory: () => ids.shift()! });
    const oldContext = await registry.create({
        instance: "demo-local",
        principal: "tester",
        workspace: "/projects/old",
    });
    const stoppedGoals: string[] = [];
    const gateway = {
        async goalContinuation() {
            return {};
        },
        async manageGoal(
            _instance: string,
            input: { action: string },
            ctxId: string,
        ) {
            if (input.action === "stop") stoppedGoals.push(ctxId);
            return undefined;
        },
        async readGoal(_instance: string, ctxId: string) {
            return ctxId === oldContext.ctxId
                ? goalSnapshot("goal-old")
                : undefined;
        },
    } as never;
    const harness = createWorker({ failAuditAfterOperation: true });
    const contextSelector = createMcpContextSelector("explicit");
    const catalog = new McpEndpointCatalog({
        contextSelector,
        instanceName: "demo-local",
        policy: { capabilities: ["read"], groups: ["file"] },
        worker: harness.worker,
    });
    const dispatch = new McpEndpointDispatch({
        catalog,
        contextSelector,
        contextRegistry: registry,
        gateway,
        instanceName: "demo-local",
        worker: harness.worker,
    });

    await assert.rejects(
        dispatch.callTool(
            "environ_info",
            { workspace: "/projects/new" },
            { principal: "tester", requestId: "request-explicit" },
        ),
        /audit finalize failed/u,
    );

    assert.equal(
        (
            await registry.validateAndTouch(oldContext.ctxId, {
                principal: "tester",
            })
        ).ctxId,
        oldContext.ctxId,
    );
    assert.deepEqual(
        (await registry.list()).map(({ ctxId, status }) => ({ ctxId, status })),
        [{ ctxId: oldContext.ctxId, status: "active" }],
    );
    assert.deepEqual(stoppedGoals, []);
    assert.deepEqual(harness.releasedAlerts, ["/projects/new"]);
});

test("successful environ_info creates a new explicit Context without retiring older Contexts", async () => {
    const ids = ["ctx-session-old", "ctx-session-new"];
    const registry = new McpContextRegistry({ idFactory: () => ids.shift()! });
    const oldContext = await registry.create({
        instance: "demo-local",
        principal: "tester",
        workspace: "/projects/old",
    });
    const releasedAlerts: string[] = [];
    const stoppedGoals: string[] = [];
    const gateway = {
        async goalContinuation() {
            return {};
        },
        async manageGoal(
            _instance: string,
            input: { action: string },
            ctxId: string,
        ) {
            if (input.action === "stop") stoppedGoals.push(ctxId);
            return undefined;
        },
        async readGoal(_instance: string, ctxId: string) {
            return ctxId === oldContext.ctxId
                ? goalSnapshot("goal-old")
                : undefined;
        },
        async releaseAlerts(_instance: string, workspace: string) {
            releasedAlerts.push(workspace);
        },
    } as never;
    const harness = createWorker();
    const contextSelector = createMcpContextSelector("explicit");
    const catalog = new McpEndpointCatalog({
        contextSelector,
        instanceName: "demo-local",
        policy: { capabilities: ["read"], groups: ["file"] },
        worker: harness.worker,
    });
    const dispatch = new McpEndpointDispatch({
        catalog,
        contextSelector,
        contextRegistry: registry,
        gateway,
        instanceName: "demo-local",
        worker: harness.worker,
    });

    const created = await dispatch.callTool(
        "environ_info",
        { workspace: "/projects/new" },
        { principal: "tester", requestId: "request-explicit" },
    );

    const createdCtxId = structuredResult<{ ctxId?: string }>(created).ctxId;
    assert.equal(createdCtxId, "ctx-session-new");
    const selected = await registry.validateAndTouch(createdCtxId!, {
        principal: "tester",
    });
    assert.equal(selected.workspace, "/projects/new");
    assert.deepEqual(
        (await registry.list()).map(({ ctxId, status }) => ({ ctxId, status })),
        [
            { ctxId: oldContext.ctxId, status: "active" },
            { ctxId: selected.ctxId, status: "active" },
        ],
    );
    assert.deepEqual(stoppedGoals, []);
    assert.deepEqual(releasedAlerts, []);
});

test("environ_info releases the previous workspace alert lease after an explicit Context switches workspace", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-switch-workspace",
    });
    const context = await registry.create({
        instance: "demo-local",
        principal: "tester",
        workspace: "/projects/old",
    });
    const harness = createWorker();
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

    const result = await dispatch.callTool(
        "environ_info",
        { ctxId: context.ctxId, workspace: "/projects/new" },
        { principal: "tester", requestId: "request-switch-workspace" },
    );

    assert.equal(structuredResult<{ ctxId?: string }>(result).ctxId, context.ctxId);
    assert.equal((await registry.list())[0]?.workspace, "/projects/new");
    assert.deepEqual(harness.releasedAlerts, ["/projects/old"]);
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

function structuredResult<T>(result: JsonValue | McpNativeToolResult): T {
    return (result instanceof McpNativeToolResult ? result.structuredContent : result) as T;
}

function goalSnapshot(goalId: string) {
    return {
        autoContinueExhausted: false,
        continuationCount: 0,
        continuationDue: false,
        continuationDueAt: "2099-01-01T00:00:00.000Z",
        continuationPending: false,
        createdAt: "2026-08-20T00:00:00.000Z",
        goalId,
        lastAgentActivityAt: "2026-08-20T00:00:00.000Z",
        maxContinuations: 10,
        objective: "Context Goal",
        revision: 1,
        status: "active" as const,
        steps: [{ id: "work", status: "active" as const, text: "Work" }],
        updatedAt: "2026-08-20T00:00:00.000Z",
    };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out waiting for test state");
}
