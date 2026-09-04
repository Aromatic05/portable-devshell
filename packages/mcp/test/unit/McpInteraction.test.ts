import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { GoalContinuationInput, JsonValue, ToolCallContext, WaitCreateInput, WaitRecord } from "@portable-devshell/shared";
import {
    McpContextRegistry,
    McpEndpointHandlerInteraction,
    McpNativeToolResult,
    McpToolCatalogInteraction,
    McpToolSchemaAdapter,
    WorkspaceAppLeaseStore,
    type McpInteractionGateway,
    type McpWorkspaceGateway,
    workspaceAppResourceUri,
} from "@portable-devshell/mcp/testing";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const context: ToolCallContext = { ctxId: "ctx-question", source: "mcp" };

test("workspace_ask holds the original call until the Workspace app answers", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);
    let settled = false;
    const held = handler.call(
        "workspace_ask",
        {
            allowText: false,
            choices: ["A", "B"],
            question: "Which implementation?",
        },
        context,
        "call-agent",
    ).then((result) => {
        settled = true;
        return result;
    });

    const wait = await fake.created;
    assert.equal(wait.kind, "question");
    assert.equal(wait.ownerCallId, "call-agent");
    assert.equal(wait.status, "waiting");
    assert.equal(settled, false);

    await handler.call(
        "workspace_answer",
        { answer: "B", token, waitId: wait.waitId },
        context,
        "call-app",
    );

    assert.deepEqual(await held, { answer: "B", questionId: wait.targetId });
    assert.equal(fake.waits[0]?.status, "consumed");
});

test("workspace_ask detaches durable wait state when the host cancels the held call", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);
    const controller = new AbortController();
    const held = handler.call(
        "workspace_ask",
        { question: "Still there?" },
        context,
        "call-agent",
        controller.signal,
    );

    const wait = await fake.created;
    controller.abort("host closed request");
    await assert.rejects(held, /cancelled by the client/i);
    assert.equal(fake.waits.find((entry) => entry.waitId === wait.waitId)?.status, "detached");
    assert.deepEqual(await handler.call(
        "workspace_answer",
        { answer: "yes", token, waitId: wait.waitId },
        context,
        "call-answer",
    ), {
        answer: "yes",
        detached: true,
        questionId: wait.targetId,
        waitId: wait.waitId,
    });
});

test("workspace_ask keeps a resolved answer recoverable when post-answer processing fails", async () => {
    const fake = createInteractionGateway();
    const gateway = Object.assign(fake.gateway, {
        async touchGoal() {
            throw new Error("goal store unavailable");
        },
    }) as McpInteractionGateway;
    const handler = new McpEndpointHandlerInteraction({ gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);
    const held = handler.call(
        "workspace_ask",
        { question: "Keep this answer?" },
        context,
        "call-agent-post-answer-failure",
    );
    const wait = await fake.created;

    await handler.call(
        "workspace_answer",
        { answer: "yes", token, waitId: wait.waitId },
        context,
        "call-answer-post-answer-failure",
    );
    await assert.rejects(held, /goal store unavailable/u);
    const recovered = fake.waits.find((entry) => entry.waitId === wait.waitId);
    assert.equal(recovered?.status, "resolved");
    assert.equal(typeof recovered?.detachedAt, "string");
    assert.deepEqual(recovered?.result, { answer: "yes" });
});

test("workspace_ask infers the current Todo association instead of requiring taskId", async () => {
    const fake = createInteractionGateway();
    const gateway = Object.assign(fake.gateway, {
        async readTodo(_instance: string, input?: { taskId?: string }) {
            if (input?.taskId === "task-1") {
                return {
                    items: [{ content: "Work", id: "item-1", status: "in_progress" }],
                    revision: 1,
                    summary: { completed: 0, total: 1 },
                    taskId: "task-1",
                    tasks: [{ ctxId: context.ctxId, status: "in_progress", taskId: "task-1" }],
                };
            }
            return {
                items: [],
                revision: 1,
                summary: { completed: 0, total: 1 },
                tasks: [{ ctxId: context.ctxId, status: "in_progress", taskId: "task-1" }],
            };
        }
    }) as McpInteractionGateway;
    const handler = new McpEndpointHandlerInteraction({ gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    const held = handler.call(
        "workspace_ask",
        { question: "Associate this automatically" },
        context,
        "call-task-associated",
    );
    const wait = await fake.created;
    assert.equal(wait.taskId, "task-1");
    await handler.call(
        "workspace_answer",
        { answer: "yes", token, waitId: wait.waitId },
        context,
        "call-answer",
    );
    await held;
});

test("workspace_ask prefers the current Goal association over Todo", async () => {
    const fake = createInteractionGateway();
    let goalTouches = 0;
    Object.assign(fake.gateway, {
        async goalContinuation() {
            return { goal: null };
        },
        async manageGoal() {
            return undefined;
        },
        async readGoal() {
            return {
                autoContinueExhausted: false,
                continuationCount: 0,
                continuationDue: false,
                continuationDueAt: "2026-08-20T00:15:00.000Z",
                continuationPending: false,
                createdAt: "2026-08-20T00:00:00.000Z",
                goalId: "goal-1",
                lastAgentActivityAt: "2026-08-20T00:00:00.000Z",
                maxContinuations: 10,
                objective: "Finish Goal mode",
                revision: 1,
                status: "active",
                steps: [{ id: "work", status: "active", text: "Work" }],
                updatedAt: "2026-08-20T00:00:00.000Z",
            };
        },
        async readTodo() {
            return {
                items: [],
                revision: 1,
                summary: { completed: 0, total: 1 },
                tasks: [{ ctxId: context.ctxId, status: "in_progress", taskId: "task-1" }],
            };
        },
        async touchGoal(_instance: string, ctxId: string) {
            assert.equal(ctxId, context.ctxId);
            goalTouches += 1;
        },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);
    const held = handler.call("workspace_ask", { question: "Which path?" }, context, "call-goal-associated");
    const wait = await fake.created;

    assert.equal(wait.goalId, "goal-1");
    assert.equal(wait.taskId, undefined);
    await handler.call(
        "workspace_answer",
        { answer: "continue", token, waitId: wait.waitId },
        context,
        "call-answer",
    );
    await held;
    assert.equal(goalTouches, 1);
});

test("Workspace authorization stays in hidden metadata and gates app-only tools", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const opened = await handler.call("workspace_open", {}, context, "call-open");
    assert.ok(opened instanceof McpNativeToolResult);
    const meta = opened._meta?.["portable-devshell/workspace"] as { token?: unknown } | undefined;
    if (typeof meta?.token !== "string") throw new Error("workspace token missing");
    assert.equal(JSON.stringify(opened.structuredContent).includes(meta.token), false);
    const snapshot = await handler.call(
        "workspace_snapshot",
        { token: meta.token },
        context,
        "call-app",
    );
    assert.ok(snapshot instanceof McpNativeToolResult);
    assert.equal((snapshot.structuredContent as { ctxId?: string }).ctxId, context.ctxId);
    assert.equal(JSON.stringify(snapshot.structuredContent).includes(meta.token), false);
    await assert.rejects(
        handler.call(
            "workspace_approval",
            { approvalId: "approval-1", decision: "approve" },
            context,
            "call-app",
        ),
        /authorization is invalid/i,
    );
});

test("Workspace App can re-establish its lifecycle after remount", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    const reconnected = await handler.call("workspace_reconnect", { token }, context, "call-reconnect");

    assert.ok(reconnected instanceof McpNativeToolResult);
    assert.equal((reconnected.structuredContent as { ctxId?: string }).ctxId, context.ctxId);
    const meta = reconnected._meta?.["portable-devshell/workspace"] as { token?: string } | undefined;
    assert.equal(meta?.token, token);
    const held = handler.call(
        "workspace_ask",
        { question: "Can the reconnected App receive a question?" },
        context,
        "call-after-reconnect",
    );
    const wait = await fake.created;
    await handler.call(
        "workspace_answer",
        { answer: "yes", token, waitId: wait.waitId },
        context,
        "call-answer",
    );
    await assert.doesNotReject(held);
});

test("Workspace reconnect refuses to mint App authorization without the existing capability", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    await assert.rejects(
        handler.call("workspace_reconnect", {}, context, "call-no-token"),
        /authorization is invalid/i,
    );
    await assert.rejects(
        handler.call("workspace_reconnect", { token: `${token}-wrong` }, context, "call-wrong-token"),
        /authorization is invalid/i,
    );
});

test("Workspace App capability survives MCP handler restart without rotating the token", async () => {
    const root = await createTestTempDirectory("workspace-app-handler-restart");
    const filePath = join(root, "workspace-app-leases.json");
    try {
        const fake = createInteractionGateway();
        const firstStore = new WorkspaceAppLeaseStore({ filePath });
        await firstStore.initialize();
        const firstHandler = new McpEndpointHandlerInteraction({
            gateway: fake.gateway,
            instanceName: "demo",
            workspaceAppLeases: firstStore,
        });
        const token = await openWorkspace(firstHandler);

        const restartedStore = new WorkspaceAppLeaseStore({ filePath });
        await restartedStore.initialize();
        const restartedHandler = new McpEndpointHandlerInteraction({
            gateway: fake.gateway,
            instanceName: "demo",
            workspaceAppLeases: restartedStore,
        });
        const reconnected = await restartedHandler.call(
            "workspace_reconnect",
            { token },
            context,
            "call-after-restart",
        );
        assert.ok(reconnected instanceof McpNativeToolResult);
        assert.equal(
            (reconnected._meta?.["portable-devshell/workspace"] as { token?: string } | undefined)?.token,
            token,
        );
        await assert.doesNotReject(restartedHandler.call(
            "workspace_snapshot",
            { token },
            context,
            "call-snapshot-after-restart",
        ));
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Workspace reconnect reuses a live App token instead of invalidating sibling mounts", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const firstToken = await openWorkspace(handler);
    const reconnected = await handler.call("workspace_reconnect", { token: firstToken }, context, "call-reconnect");
    assert.ok(reconnected instanceof McpNativeToolResult);
    const secondToken = (reconnected._meta?.["portable-devshell/workspace"] as { token: string }).token;
    assert.equal(secondToken, firstToken);
    await assert.doesNotReject(handler.call(
        "workspace_snapshot",
        { token: firstToken },
        context,
        "call-sibling-snapshot",
    ));
});

test("Workspace sibling requests keep their own verified capability token", async () => {
    const root = await createTestTempDirectory("workspace-app-sibling-capabilities");
    const filePath = join(root, "workspace-app-leases.json");
    try {
        const firstStore = new WorkspaceAppLeaseStore({ filePath, tokenFactory: () => "token-sibling-first" });
        await firstStore.initialize();
        const firstToken = await firstStore.issue("demo", context.ctxId!);
        const secondStore = new WorkspaceAppLeaseStore({ filePath, tokenFactory: () => "token-sibling-second" });
        await secondStore.initialize();
        const secondToken = await secondStore.issue("demo", context.ctxId!);
        assert.notEqual(firstToken, secondToken);

        const fake = createInteractionGateway();
        let listCalls = 0;
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
        const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const gateway = Object.assign(fake.gateway, {
            async listWaits() {
                listCalls += 1;
                if (listCalls === 1) {
                    markFirstStarted();
                    await firstBlocked;
                }
                return [];
            },
            async readToolCalls() { return []; },
            async readWorkspaceEvents() { return { events: [], gap: false, lastSeq: 0 }; },
        }) as McpWorkspaceGateway;
        const handler = new McpEndpointHandlerInteraction({
            gateway,
            instanceName: "demo",
            workspaceAppLeases: secondStore,
        });

        const first = handler.call("workspace_snapshot", { token: firstToken }, context, "call-sibling-first");
        await firstStarted;
        const second = await handler.call("workspace_snapshot", { token: secondToken }, context, "call-sibling-second");
        releaseFirst();
        const firstResult = await first;
        assert.ok(firstResult instanceof McpNativeToolResult);
        assert.ok(second instanceof McpNativeToolResult);
        assert.equal(
            (firstResult._meta?.["portable-devshell/workspace"] as { token?: string } | undefined)?.token,
            firstToken,
        );
        assert.equal(
            (second._meta?.["portable-devshell/workspace"] as { token?: string } | undefined)?.token,
            secondToken,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Workspace snapshot projects only compact task and background state", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push(
        {
            createdAt: now,
            createdByCtxId: context.ctxId!,
            kind: "tmux",
            status: "waiting",
            targetId: "tmux-task-1",
            taskId: "task-1",
            updatedAt: now,
            waitId: "wait-tmux",
        },
        {
            createdAt: now,
            createdByCtxId: context.ctxId!,
            detachedAt: now,
            kind: "question",
            payload: { allowText: true, choices: [], question: "Continue?" },
            resolvedAt: now,
            result: { answer: "yes" },
            status: "resolved",
            targetId: "question-resolved",
            updatedAt: now,
            waitId: "wait-question-resolved",
        },
    );
    const gateway = Object.assign(fake.gateway, {
        async controlTodo() { return {}; },
        async readTodo() {
            return {
                items: [],
                revision: 0,
                summary: { completed: 0, total: 0 },
                tasks: [{
                    completed: 0,
                    ctxId: context.ctxId,
                    revision: 1,
                    status: "in_progress",
                    taskId: "task-1",
                    title: "Task",
                    total: 1,
                    updatedAt: now,
                }]
            };
        },
        hasActiveToolCalls() { return true; },
        async listPendingApprovals() { return []; },
        async readToolCalls() { throw new Error("workspace snapshot should not read historical tool calls"); },
        async readWorkspaceEvents() {
            return { events: [], gap: false, lastSeq: 7 };
        },
    }) as McpWorkspaceGateway;
    const handler = new McpEndpointHandlerInteraction({ gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    const result = await handler.call("workspace_snapshot", { token }, context, "call-app");
    assert.ok(result instanceof McpNativeToolResult);
    const snapshot = result.structuredContent as {
        agentBusy?: boolean;
        background?: Array<Record<string, unknown>>;
        currentEvent?: Record<string, unknown> | null;
        cursor?: number;
        tasks?: Array<Record<string, unknown>>;
    };
    assert.equal(snapshot.cursor, 7);
    assert.equal(snapshot.agentBusy, true);
    const tmuxBackground = snapshot.background?.find((entry) => entry.waitId === "wait-tmux");
    const questionRecovery = snapshot.background?.find((entry) => entry.waitId === "wait-question-resolved");
    assert.equal(tmuxBackground?.tmuxTaskId, "tmux-task-1");
    assert.equal(tmuxBackground?.taskId, "task-1");
    assert.equal(questionRecovery?.kind, "question");
    assert.equal(questionRecovery?.tmuxTaskId, undefined);
    assert.deepEqual(questionRecovery?.result, { answer: "yes" });
    assert.equal(snapshot.currentEvent, null);
    assert.equal(Object.hasOwn(snapshot, "activity"), false);
    assert.equal(Object.hasOwn(snapshot.tasks?.[0] ?? {}, "ctxId"), false);
    assert.equal(Object.hasOwn(snapshot, "waits"), false);
});

test("Workspace snapshot aggregates remote Context activity and approvals", async () => {
    const fake = createInteractionGateway();
    const registry = new McpContextRegistry({ idFactory: () => context.ctxId! });
    const created = await registry.create({ instance: "demo", principal: "tester", workspace: "/local" });
    assert.equal(created.ctxId, context.ctxId);
    await registry.attachEnvironment(context.ctxId!, { instance: "remote", workspace: "/remote" });
    Object.assign(fake.gateway, {
        async listApprovals(instance: string) {
            return instance === "remote" ? [{
                approvalId: "approval-remote",
                callId: "call-remote",
                createdAt: "2026-08-31T00:00:00.000Z",
                ctxId: context.ctxId,
                expiresAt: "2026-08-31T01:00:00.000Z",
                inputSummary: "remote command",
                instance: "remote",
                reason: "approval required",
                riskLevel: "medium",
                source: "mcp",
                status: "pending",
                toolName: "bash_run",
            }] : [];
        },
        async readToolCalls(instance: string) {
            return instance === "remote" ? [{
                callId: "call-remote",
                ctxId: context.ctxId,
                inputSummary: "remote command",
                instance: "remote",
                source: "mcp",
                startedAt: "2026-08-31T00:00:00.000Z",
                status: "running",
                toolName: "bash_run",
            }] : [];
        },
        async readWorkspaceEvents() {
            return { events: [], gap: false, lastSeq: 1 };
        },
    });
    const handler = new McpEndpointHandlerInteraction({
        contextRegistry: registry,
        gateway: fake.gateway,
        instanceName: "demo",
    });
    const token = await openWorkspace(handler);
    const result = await handler.call("workspace_snapshot", { token }, context, "call-remote-snapshot");
    assert.ok(result instanceof McpNativeToolResult);
    const snapshot = result.structuredContent as {
        agentBusy?: boolean;
        approvals?: Array<{ approvalId?: string }>;
    };
    assert.equal(snapshot.agentBusy, true);
    assert.deepEqual(snapshot.approvals?.map((approval) => approval.approvalId), ["approval-remote"]);
});

test("Workspace snapshot never advances its cursor past state collected afterward", async () => {
    const fake = createInteractionGateway();
    let eventSeq = 5;
    let snapshotPhase = false;
    Object.assign(fake.gateway, {
        async readToolCalls() { return []; },
        async readTodo() {
            if (snapshotPhase) eventSeq = 6;
            return { items: [], revision: 0, summary: { completed: 0, total: 0 }, tasks: [] };
        },
        async readWorkspaceEvents(_instance: string, fromSeq: number) {
            if (fromSeq === Number.MAX_SAFE_INTEGER) {
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            return { events: [], gap: false, lastSeq: eventSeq };
        },
    });
    const handler = new McpEndpointHandlerInteraction({
        gateway: fake.gateway,
        instanceName: "demo",
    });
    const token = await openWorkspace(handler);
    snapshotPhase = true;

    const result = await handler.call("workspace_snapshot", { token }, context, "call-conservative-cursor");
    assert.ok(result instanceof McpNativeToolResult);
    const snapshot = result.structuredContent as { cursor?: number };
    assert.equal(snapshot.cursor, 5);
});

test("workspace_watch reconciles multi-instance Contexts within one second even on MCP fallback", async () => {
    const fake = createInteractionGateway();
    const registry = new McpContextRegistry({ idFactory: () => context.ctxId! });
    await registry.create({ instance: "demo", principal: "tester", workspace: "/local" });
    await registry.attachEnvironment(context.ctxId!, { instance: "remote", workspace: "/remote" });
    let now = 0;
    let watchReads = 0;
    Object.assign(fake.gateway, {
        async readToolCalls() { return []; },
        async readWorkspaceEvents(_instance: string, fromSeq: number) {
            if (fromSeq !== Number.MAX_SAFE_INTEGER) {
                watchReads += 1;
                now += 1_000;
            }
            return { events: [], gap: false, lastSeq: 0 };
        },
    });
    const handler = new McpEndpointHandlerInteraction({
        contextRegistry: registry,
        gateway: fake.gateway,
        instanceName: "demo",
        now: () => now,
        watchHeartbeatMs: 60_000,
        watchPollMs: 1,
    });
    const token = await openWorkspace(handler);

    const result = await handler.call("workspace_watch", { cursor: 0, token }, context, "call-multi-watch");
    assert.ok(result instanceof McpNativeToolResult);
    const update = result.structuredContent as { changed?: boolean; snapshot?: unknown };
    assert.equal(update.changed, false);
    assert.notEqual(update.snapshot, undefined);
    assert.equal(watchReads, 1);
});

test("Workspace currentEvent keeps human actions FIFO and ignores tmux waits", async () => {
    const fake = createInteractionGateway();
    fake.waits.push(
        {
            createdAt: "2026-08-20T00:00:00.000Z",
            createdByCtxId: context.ctxId!,
            kind: "question",
            payload: { allowText: true, choices: [], question: "Oldest question" },
            status: "waiting",
            targetId: "question-old",
            updatedAt: "2026-08-20T00:00:00.000Z",
            waitId: "wait-old",
        },
        {
            createdAt: "2026-08-20T00:00:02.000Z",
            createdByCtxId: context.ctxId!,
            kind: "tmux",
            status: "waiting",
            targetId: "tmux-new",
            updatedAt: "2026-08-20T00:00:02.000Z",
            waitId: "wait-tmux-new",
        },
        {
            createdAt: "2026-08-20T00:00:03.000Z",
            createdByCtxId: context.ctxId!,
            kind: "question",
            payload: { allowText: true, choices: [], question: "Newer question" },
            status: "waiting",
            targetId: "question-new",
            updatedAt: "2026-08-20T00:00:03.000Z",
            waitId: "wait-new",
        },
    );
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);
    const result = await handler.call("workspace_snapshot", { token }, context, "call-app");
    assert.ok(result instanceof McpNativeToolResult);
    const currentEvent = (result.structuredContent as { currentEvent?: Record<string, unknown> }).currentEvent;
    assert.equal(currentEvent?.kind, "question");
    assert.equal(currentEvent?.waitId, "wait-old");
});

test("Workspace question answer reports owner loss that races with resolution", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push({
        createdAt: now,
        createdByCtxId: context.ctxId!,
        kind: "question",
        payload: { allowText: true, choices: [], question: "Race?" },
        status: "waiting",
        targetId: "question-race",
        updatedAt: now,
        waitId: "wait-question-race",
    });
    const gateway = Object.assign(fake.gateway, {
        async resolveWait(_instance: string, waitId: string, result?: JsonValue) {
            const record = fake.waits.find((entry) => entry.waitId === waitId)!;
            record.detachedAt = new Date().toISOString();
            record.resolvedAt = new Date().toISOString();
            record.result = result;
            record.status = "resolved";
            record.updatedAt = record.resolvedAt;
            return structuredClone(record);
        },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    const result = await handler.call(
        "workspace_answer",
        { answer: "yes", token, waitId: "wait-question-race" },
        context,
        "call-answer-race",
    ) as { detached?: boolean };
    assert.equal(result.detached, true);
});

test("Workspace can interrupt a live tmux wait without cancelling the tmux task", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push({
        createdAt: now,
        createdByCtxId: context.ctxId!,
        kind: "tmux",
        ownerCallId: "call-tmux-wait",
        status: "waiting",
        targetId: "tmux-task-1",
        taskId: "task-1",
        updatedAt: now,
        waitId: "wait-tmux",
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    assert.deepEqual(await handler.call(
        "workspace_interrupt",
        { token, waitId: "wait-tmux" },
        context,
        "call-app",
    ), {
        detached: false,
        interrupted: true,
        status: "resolved",
        taskId: "task-1",
        tmuxTaskId: "tmux-task-1",
        waitId: "wait-tmux",
    });
    assert.equal(fake.waits[0]?.status, "resolved");
    assert.deepEqual(fake.waits[0]?.result, {
        interrupted: true,
        task: { id: "tmux-task-1", status: "running" },
    });
});

test("Workspace wait interruption reports owner loss that races with resolution", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push({
        createdAt: now,
        createdByCtxId: context.ctxId!,
        kind: "tmux",
        ownerCallId: "call-race",
        status: "waiting",
        targetId: "tmux-race",
        updatedAt: now,
        waitId: "wait-tmux-race",
    });
    const gateway = Object.assign(fake.gateway, {
        async resolveWait(_instance: string, waitId: string, result?: JsonValue) {
            const record = fake.waits.find((entry) => entry.waitId === waitId)!;
            record.detachedAt = new Date().toISOString();
            record.resolvedAt = new Date().toISOString();
            record.result = result;
            record.status = "resolved";
            record.updatedAt = record.resolvedAt;
            return structuredClone(record);
        },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);
    const result = await handler.call(
        "workspace_interrupt",
        { token, waitId: "wait-tmux-race" },
        context,
        "call-interrupt-race",
    ) as { detached?: boolean };
    assert.equal(result.detached, true);
});

test("Workspace Goal revision changes disable revision-only detached wait recovery", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push({
        createdAt: now,
        createdByCtxId: context.ctxId!,
        detachedAt: now,
        goalId: "goal-revision",
        goalRevision: 1,
        kind: "tmux",
        resolvedAt: now,
        result: { task: { status: "0" } },
        status: "resolved",
        targetId: "tmux-goal-revision",
        updatedAt: now,
        waitId: "wait-goal-revision",
    });
    const goal = {
        autoContinueExhausted: false,
        continuationCount: 0,
        continuationDue: false,
        continuationDueAt: "2026-08-20T00:15:00.000Z",
        continuationPending: false,
        createdAt: now,
        goalId: "goal-revision",
        lastAgentActivityAt: now,
        maxContinuations: 10,
        objective: "Finish revision-only Goal work",
        revision: 2,
        status: "active" as const,
        steps: [{ id: "done", status: "completed" as const, text: "Already done" }],
        updatedAt: now,
    };
    Object.assign(fake.gateway, {
        async goalContinuation() { return { goal }; },
        async manageGoal() { return goal; },
        async readGoal() { return goal; },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });

    await handler.call(
        "workspace_goal",
        { action: "update", objective: goal.objective },
        context,
        "call-goal-revision-update",
    );

    const wait = fake.waits.find((entry) => entry.waitId === "wait-goal-revision");
    assert.equal(wait?.automaticRecovery, false);
    assert.equal(typeof wait?.recoveryDisabledAt, "string");
});

test("Workspace Goal metadata revisions preserve progress-bound detached wait recovery", async () => {
    const fake = createInteractionGateway();
    const progressAt = "2026-08-20T00:00:00.000Z";
    fake.waits.push({
        createdAt: progressAt,
        createdByCtxId: context.ctxId!,
        detachedAt: progressAt,
        goalId: "goal-progress-token",
        goalProgressAt: progressAt,
        goalRevision: 1,
        kind: "tmux",
        resolvedAt: progressAt,
        result: { task: { status: "0" } },
        status: "resolved",
        targetId: "tmux-goal-progress-token",
        updatedAt: progressAt,
        waitId: "wait-goal-progress-token",
    });
    const goal = {
        autoContinueExhausted: false,
        continuationCount: 0,
        continuationDue: false,
        continuationDueAt: "2026-08-20T00:15:00.000Z",
        continuationPending: false,
        createdAt: progressAt,
        goalId: "goal-progress-token",
        lastAgentActivityAt: "2026-08-20T00:01:00.000Z",
        lastProgressAt: progressAt,
        maxContinuations: 10,
        objective: "Keep recovery across control-only revisions",
        revision: 2,
        status: "active" as const,
        steps: [{ id: "done", status: "completed" as const, text: "Already done" }],
        updatedAt: "2026-08-20T00:01:00.000Z",
    };
    Object.assign(fake.gateway, {
        async goalContinuation() { return { goal }; },
        async manageGoal() { return goal; },
        async readGoal() { return goal; },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });

    await handler.call(
        "workspace_goal",
        { action: "update", note: "control metadata only" },
        context,
        "call-goal-progress-token-update",
    );

    const wait = fake.waits.find((entry) => entry.waitId === "wait-goal-progress-token");
    assert.notEqual(wait?.automaticRecovery, false);
    assert.equal(wait?.recoveryDisabledAt, undefined);
});

test("workspace_watch skips unrelated events and returns on the current Context event", async () => {
    const fake = createInteractionGateway();
    let watchReads = 0;
    const gateway = Object.assign(fake.gateway, {
        async controlTodo() { return {}; },
        async readToolCalls() { return []; },
        async readWorkspaceEvents(_instance: string, fromSeq: number) {
            if (fromSeq === Number.MAX_SAFE_INTEGER) {
                return { events: [], gap: false, lastSeq: 2 };
            }
            watchReads += 1;
            if (fromSeq === 1) {
                return {
                    events: [{
                        at: new Date().toISOString(),
                        data: { ctxId: "ctx-other" },
                        instanceName: "demo",
                        seq: 1,
                        type: "toolCall.running" as const,
                    }],
                    gap: false,
                    lastSeq: 1,
                };
            }
            return {
                events: [{
                    at: new Date().toISOString(),
                    data: { createdByCtxId: context.ctxId },
                    instanceName: "demo",
                    seq: 2,
                    type: "wait.created" as const,
                }],
                gap: false,
                lastSeq: 2,
            };
        },
    }) as McpWorkspaceGateway;
    const handler = new McpEndpointHandlerInteraction({
        gateway,
        instanceName: "demo",
        watchHeartbeatMs: 100,
        watchPollMs: 1,
    });
    const token = await openWorkspace(handler);

    const result = await handler.call("workspace_watch", { cursor: 0, token }, context, "call-watch");
    assert.ok(result instanceof McpNativeToolResult);
    const update = result.structuredContent as { changed?: boolean; cursor?: number; snapshot?: { cursor?: number } };
    assert.equal(update.changed, true);
    assert.equal(update.cursor, 2);
    assert.equal(update.snapshot?.cursor, 2);
    assert.equal(watchReads, 2);
});

test("workspace_watch ignores internal wait recovery ownership events", async () => {
    const fake = createInteractionGateway();
    const gateway = Object.assign(fake.gateway, {
        async controlTodo() { return {}; },
        async readToolCalls() { return []; },
        async readWorkspaceEvents(_instance: string, fromSeq: number) {
            if (fromSeq === Number.MAX_SAFE_INTEGER) {
                return { events: [], gap: false, lastSeq: 1 };
            }
            return {
                events: [{
                    at: new Date().toISOString(),
                    data: { createdByCtxId: context.ctxId },
                    instanceName: "demo",
                    seq: 1,
                    type: "wait.recoveryReleased" as const,
                }],
                gap: false,
                lastSeq: 1,
            };
        },
    }) as McpWorkspaceGateway;
    const handler = new McpEndpointHandlerInteraction({
        gateway,
        instanceName: "demo",
        watchHeartbeatMs: 0,
        watchPollMs: 1,
    });
    const token = await openWorkspace(handler);

    const result = await handler.call("workspace_watch", { cursor: 0, token }, context, "call-watch-internal");
    assert.ok(result instanceof McpNativeToolResult);
    const update = result.structuredContent as { changed?: boolean; cursor?: number };
    assert.equal(update.changed, false);
    assert.equal(update.cursor, 1);
});

test("workspace_watch heartbeat reconciles from an authoritative snapshot", async () => {
    const fake = createInteractionGateway();
    const gateway = Object.assign(fake.gateway, {
        async controlTodo() { return {}; },
        async readToolCalls() { return []; },
        async readWorkspaceEvents() {
            return { events: [], gap: false, lastSeq: 11 };
        },
    }) as McpWorkspaceGateway;
    const handler = new McpEndpointHandlerInteraction({
        gateway,
        instanceName: "demo",
        watchHeartbeatMs: 0,
        watchPollMs: 1,
    });
    const token = await openWorkspace(handler);

    const result = await handler.call("workspace_watch", { cursor: 7, token }, context, "call-watch");
    assert.ok(result instanceof McpNativeToolResult);
    assert.deepEqual(result.structuredContent, {
        changed: false,
        cursor: 11,
        snapshot: {
            agentBusy: false,
            approvals: [],
            background: [],
            ctxId: context.ctxId,
            currentEvent: null,
            cursor: 11,
            goal: null,
            instance: "demo",
            questions: [],
            reentry: { epoch: 0, pending: false },
            tasks: [],
        },
    });
});

test("workspace_ask refuses to hold a call before Workspace is open", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({
        gateway: fake.gateway,
        instanceName: "demo",
        workspaceActivationGraceMs: 5,
    });
    await assert.rejects(
        handler.call(
            "workspace_ask",
            { question: "Invisible question?" },
            context,
            "call-agent",
        ),
        /workspace_open/i,
    );
    await handler.call("workspace_open", {}, context, "call-open-only");
    await assert.rejects(
        handler.call(
            "workspace_ask",
            { question: "Panel mounted yet?" },
            context,
            "call-agent-open-only",
        ),
        /current ctxId and workspace remain valid/i,
    );
    assert.equal(fake.waits.length, 0);
});

test("workspace_ask waits briefly for the Workspace App to establish a live watch", async () => {
    const fake = createInteractionGateway();
    const gateway = Object.assign(fake.gateway, {
        async readToolCalls() { return []; },
        async readWorkspaceEvents() { return { events: [], gap: false, lastSeq: 0 }; },
    }) as McpWorkspaceGateway;
    const handler = new McpEndpointHandlerInteraction({
        gateway,
        instanceName: "demo",
        watchHeartbeatMs: 60_000,
        watchPollMs: 1,
        workspaceActivationGraceMs: 100,
    });
    const opened = await handler.call("workspace_open", {}, context, "call-open");
    assert.ok(opened instanceof McpNativeToolResult);
    const token = (opened._meta?.["portable-devshell/workspace"] as { token?: string } | undefined)?.token;
    if (token === undefined) throw new Error("workspace token missing");

    const held = handler.call(
        "workspace_ask",
        { question: "Mounted during grace?" },
        context,
        "call-agent-grace",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const watchAbort = new AbortController();
    const watch = handler.call(
        "workspace_watch",
        { cursor: 0, token },
        context,
        "call-app-watch",
        watchAbort.signal,
    );
    const wait = await fake.created;
    await handler.call(
        "workspace_answer",
        { answer: "yes", token, waitId: wait.waitId },
        context,
        "call-answer",
    );
    assert.deepEqual(await held, { answer: "yes", questionId: wait.targetId });
    watchAbort.abort();
    await assert.rejects(watch);
});

test("workspace_ask refuses to create a held call after the live Workspace watch is torn down", async () => {
    let now = 1_000;
    const fake = createInteractionGateway();
    const gateway = Object.assign(fake.gateway, {
        async readToolCalls() { return []; },
        async readWorkspaceEvents() { return { events: [], gap: false, lastSeq: 0 }; },
    }) as McpWorkspaceGateway;
    const handler = new McpEndpointHandlerInteraction({
        gateway,
        instanceName: "demo",
        now: () => now,
        watchHeartbeatMs: 60_000,
        watchPollMs: 1,
        workspaceActivationGraceMs: 5,
    });
    const token = await openWorkspace(handler);
    const watchAbort = new AbortController();
    const watch = handler.call(
        "workspace_watch",
        { cursor: 0, token },
        context,
        "call-app-watch",
        watchAbort.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    watchAbort.abort();
    await assert.rejects(watch);
    now += 5_001;

    const askAbort = new AbortController();
    const held = handler.call(
        "workspace_ask",
        { question: "Is anyone still there?" },
        context,
        "call-agent-stale",
        askAbort.signal,
    );
    setTimeout(() => askAbort.abort(), 50);
    await assert.rejects(held, /current ctxId and workspace remain valid/i);
    assert.equal(fake.waits.length, 0);
});

test("workspace_goal start requires a presented Workspace but not a live App handshake", async () => {
    const fake = createInteractionGateway();
    let starts = 0;
    Object.assign(fake.gateway, {
        async goalContinuation() {
            return { goal: null };
        },
        async manageGoal(_instance: string, input: { action: string }) {
            if (input.action === "start") starts += 1;
            return undefined;
        },
        async readGoal() {
            return undefined;
        },
    });
    const handler = new McpEndpointHandlerInteraction({
        gateway: fake.gateway,
        instanceName: "demo",
        workspaceActivationGraceMs: 5,
    });
    const start = {
        action: "start",
        objective: "Visible Goal",
        steps: [{ id: "work", text: "Do the work" }],
    };

    await assert.rejects(
        handler.call("workspace_goal", start, context, "call-goal-headless"),
        /requires an initialized Workspace/u,
    );
    assert.equal(starts, 0);

    const opened = await handler.call("workspace_open", {}, context, "call-open");
    assert.ok(opened instanceof McpNativeToolResult);
    await handler.call("workspace_goal", start, context, "call-goal-open-only");
    assert.equal(starts, 1);
});

test("Workspace can resume a blocked Goal through the app-only control", async () => {
    const fake = createInteractionGateway();
    const actions: string[] = [];
    const now = new Date().toISOString();
    fake.waits.push({
        createdAt: now,
        createdByCtxId: context.ctxId!,
        detachedAt: now,
        goalId: "goal-1",
        goalRevision: 1,
        kind: "tmux",
        resolvedAt: now,
        result: { task: { status: "0" } },
        status: "resolved",
        targetId: "tmux-goal-resume",
        updatedAt: now,
        waitId: "wait-goal-resume",
    });
    Object.assign(fake.gateway, {
        async goalContinuation() {
            return { goal: null };
        },
        async manageGoal(_instance: string, input: { action: string }) {
            actions.push(input.action);
            return input.action === "resume"
                ? { goalId: "goal-1", objective: "Resume work", revision: 2, status: "active", steps: [] }
                : undefined;
        },
        async readGoal() {
            return { goalId: "goal-1", objective: "Resume work", revision: 1, status: "blocked", steps: [] };
        },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    const result = await handler.call(
        "workspace_resume",
        { goalId: "goal-1", revision: 1, token },
        context,
        "call-goal-resume",
    ) as { goal?: { status?: string } };
    assert.deepEqual(actions, ["resume"]);
    assert.equal(result.goal?.status, "active");
    const wait = fake.waits.find((entry) => entry.waitId === "wait-goal-resume");
    assert.equal(wait?.automaticRecovery, false);
    assert.equal(typeof wait?.recoveryDisabledAt, "string");
});

test("server re-entry arbiter gives each resolved Wait at most one notification and fences concurrent clients", async () => {
    const root = await createTestTempDirectory("reentry-wait-once");
    try {
        const registry = new McpContextRegistry({
            filePath: join(root, "contexts.json"),
            idFactory: () => context.ctxId!,
        });
        await registry.initialize();
        await registry.create({ instance: "demo", principal: "local", workspace: "/workspace" });
        const fake = createInteractionGateway();
        const now = new Date().toISOString();
        fake.waits.push({
            automaticRecovery: true,
            createdAt: now,
            createdByCtxId: context.ctxId!,
            detachedAt: now,
            kind: "tmux",
            resolvedAt: now,
            result: { task: { id: "task-once", status: "0" } },
            status: "resolved",
            targetId: "task-once",
            updatedAt: now,
            waitId: "wait-once",
        });
        const handler = new McpEndpointHandlerInteraction({
            contextRegistry: registry,
            gateway: fake.gateway,
            instanceName: "demo",
        });
        const token = await openWorkspace(handler);
        const claim = (claimId: string) => handler.call(
            "workspace_reentry",
            { action: "claim", claimId, intent: "automatic", token },
            context,
            `call-${claimId}`,
        ) as Promise<{ claimed?: boolean; claimId?: string; delivery?: { kind?: string; sourceId?: string }; sourceKind?: string }>;

        const [left, right] = await Promise.all([claim("claim-left"), claim("claim-right")]);
        const winners = [left, right].filter((value) => value.claimed === true);
        assert.equal(winners.length, 1);
        const winner = winners[0]!;
        assert.equal(winner.delivery?.kind, "wait");
        assert.equal(winner.delivery?.sourceId, "wait-once");
        assert.equal(winner.sourceKind, "wait");
        const claimId = winner.claimId!;

        const validated = await handler.call(
            "workspace_reentry",
            { action: "validate", claimId, token },
            context,
            "call-validate-wait-once",
        ) as { valid?: boolean };
        assert.equal(validated.valid, true);
        const attempted = await handler.call(
            "workspace_reentry",
            { action: "attempt", claimId, token },
            context,
            "call-attempt-wait-once",
        ) as { attempted?: boolean };
        assert.equal(attempted.attempted, true);
        await handler.call(
            "workspace_reentry",
            { action: "report", claimId, outcome: "rejected", token },
            context,
            "call-report-wait-once",
        );
        assert.equal(fake.waits.find((wait) => wait.waitId === "wait-once")?.status, "consumed");
        assert.equal((await claim("claim-after-consume")).claimed, false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("v0.6.15 Workspace iframe keeps Context arbitration separate from Goal continuation claims", async () => {
    const root = await createTestTempDirectory("legacy-workspace-goal-reentry");
    try {
        const registry = new McpContextRegistry({
            filePath: join(root, "contexts.json"),
            idFactory: () => context.ctxId!,
        });
        await registry.initialize();
        await registry.create({ instance: "demo", principal: "local", workspace: "/workspace" });
        const fake = createInteractionGateway();
        const now = new Date().toISOString();
        const goal = {
            autoContinueExhausted: false,
            continuationCount: 0,
            continuationDue: true,
            continuationDueAt: now,
            continuationPending: false,
            createdAt: now,
            goalId: "goal-legacy",
            lastAgentActivityAt: now,
            lastProgressAt: now,
            maxContinuations: 8,
            objective: "Continue legacy iframe",
            revision: 1,
            status: "active" as const,
            steps: [{ id: "work", status: "active" as const, text: "Work" }],
            updatedAt: now,
        };
        const continuationClaims: string[] = [];
        Object.assign(fake.gateway, {
            async goalContinuation(_instance: string, input: GoalContinuationInput) {
                if (input.action === "claim" && input.claimId !== undefined) continuationClaims.push(input.claimId);
                return {
                    claimed: input.action === "claim",
                    claimId: input.claimId,
                    continuationCount: 0,
                    goal,
                };
            },
            async manageGoal() { return goal; },
            async readGoal() { return goal; },
        });
        const handler = new McpEndpointHandlerInteraction({
            contextRegistry: registry,
            gateway: fake.gateway,
            instanceName: "demo",
        });
        const token = await openWorkspace(handler);

        const contextClaim = await handler.callLegacyV0615(
            "workspace_reentry_control",
            { action: "claim", claimId: "context-claim", token },
            context,
        ) as { claimed?: boolean; claimId?: string };
        assert.equal(contextClaim.claimed, true);
        assert.equal(contextClaim.claimId, "context-claim");

        const goalClaim = await handler.callLegacyV0615(
            "workspace_goal_continue",
            { action: "claim", available: true, claimId: "goal-claim", token },
            context,
        ) as { claimed?: boolean; claimId?: string };
        assert.equal(goalClaim.claimed, true);
        assert.equal(goalClaim.claimId, "goal-claim");
        assert.deepEqual(continuationClaims, ["goal-claim"]);
        assert.equal((await registry.readAutomaticReentry(context.ctxId!, "demo")).claimId, "context-claim");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("v0.6.15 Workspace wait sent then release stays idempotent on the current Wait model", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push({
        automaticRecovery: true,
        createdAt: now,
        createdByCtxId: context.ctxId!,
        detachedAt: now,
        kind: "tmux",
        resolvedAt: now,
        result: { task: { id: "task-legacy", status: "0" } },
        status: "resolved",
        targetId: "task-legacy",
        updatedAt: now,
        waitId: "wait-legacy",
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    const claimed = await handler.callLegacyV0615(
        "workspace_wait_recover",
        { action: "claim", token, waitId: "wait-legacy" },
        context,
    ) as { claimId?: string };
    assert.equal(typeof claimed.claimId, "string");
    const claimId = claimed.claimId!;
    await handler.callLegacyV0615(
        "workspace_wait_recover",
        { action: "attempt", claimId, token, waitId: "wait-legacy" },
        context,
    );
    const sent = await handler.callLegacyV0615(
        "workspace_wait_recover",
        { action: "sent", claimId, token, waitId: "wait-legacy" },
        context,
    ) as { sent?: boolean };
    assert.equal(sent.sent, true);
    assert.equal(fake.waits.find((wait) => wait.waitId === "wait-legacy")?.status, "consumed");
    assert.deepEqual(
        await handler.callLegacyV0615(
            "workspace_wait_recover",
            { action: "release", claimId, token, waitId: "wait-legacy" },
            context,
        ),
        { released: true, waitId: "wait-legacy" },
    );
});

test("server re-entry arbiter consumes a resolved Wait without notification while Context execution is active", async () => {
    const root = await createTestTempDirectory("reentry-wait-busy");
    try {
        const nowMs = Date.parse("2026-09-03T00:00:00.000Z");
        const registry = new McpContextRegistry({
            filePath: join(root, "contexts.json"),
            idFactory: () => context.ctxId!,
            now: () => nowMs,
        });
        await registry.initialize();
        await registry.create({ instance: "demo", principal: "local", workspace: "/workspace" });
        await registry.observeExecutionActivity(context.ctxId!, "demo");
        const fake = createInteractionGateway();
        const now = new Date(nowMs).toISOString();
        fake.waits.push({
            automaticRecovery: true,
            createdAt: now,
            createdByCtxId: context.ctxId!,
            detachedAt: now,
            kind: "tmux",
            resolvedAt: now,
            result: { task: { id: "task-busy", status: "0" } },
            status: "resolved",
            targetId: "task-busy",
            updatedAt: now,
            waitId: "wait-busy",
        });
        const handler = new McpEndpointHandlerInteraction({
            contextRegistry: registry,
            gateway: fake.gateway,
            instanceName: "demo",
        });
        const token = await openWorkspace(handler);
        const result = await handler.call(
            "workspace_reentry",
            { action: "claim", claimId: "claim-busy", intent: "automatic", token },
            context,
            "call-claim-busy",
        ) as { claimed?: boolean; executionActive?: boolean };
        assert.equal(result.claimed, false);
        assert.equal(result.executionActive, true);
        assert.equal(fake.waits.find((wait) => wait.waitId === "wait-busy")?.status, "consumed");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("server re-entry arbiter revalidates an associated task between claim and attempt", async () => {
    const root = await createTestTempDirectory("reentry-task-fence");
    try {
        const registry = new McpContextRegistry({
            filePath: join(root, "contexts.json"),
            idFactory: () => context.ctxId!,
        });
        await registry.initialize();
        await registry.create({ instance: "demo", principal: "local", workspace: "/workspace" });
        const fake = createInteractionGateway();
        let taskStatus = "in_progress";
        const now = new Date().toISOString();
        fake.waits.push({
            automaticRecovery: true,
            createdAt: now,
            createdByCtxId: context.ctxId!,
            detachedAt: now,
            kind: "tmux",
            resolvedAt: now,
            result: { task: { id: "tmux-task-fence", status: "0" } },
            status: "resolved",
            targetId: "tmux-task-fence",
            taskId: "task-fence",
            updatedAt: now,
            waitId: "wait-task-fence",
        });
        Object.assign(fake.gateway, {
            async readTodo(_instance: string, input?: { taskId?: string }) {
                return {
                    items: [],
                    revision: 1,
                    summary: { completed: 0, total: 1 },
                    ...(input?.taskId === "task-fence" ? { taskId: "task-fence" } : {}),
                    tasks: [{ ctxId: context.ctxId, status: taskStatus, taskId: "task-fence" }],
                };
            },
        });
        const handler = new McpEndpointHandlerInteraction({ contextRegistry: registry, gateway: fake.gateway, instanceName: "demo" });
        const token = await openWorkspace(handler);
        const claim = await handler.call(
            "workspace_reentry",
            { action: "claim", claimId: "claim-task-fence", intent: "automatic", token },
            context,
            "call-task-fence-claim",
        ) as { claimed?: boolean; delivery?: { kind?: string } };
        assert.equal(claim.claimed, true);
        assert.equal(claim.delivery?.kind, "wait");

        taskStatus = "paused";
        const validated = await handler.call(
            "workspace_reentry",
            { action: "validate", claimId: "claim-task-fence", token },
            context,
            "call-task-fence-validate",
        ) as { valid?: boolean };
        assert.equal(validated.valid, false);
        assert.equal(fake.waits.find((wait) => wait.waitId === "wait-task-fence")?.status, "consumed");
        assert.equal(fake.waits.find((wait) => wait.waitId === "wait-task-fence")?.recoveryMessageAttemptedAt, undefined);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("server re-entry arbiter rejects a claimed Wait after its Goal is replaced", async () => {
    const root = await createTestTempDirectory("reentry-goal-fence");
    try {
        const registry = new McpContextRegistry({
            filePath: join(root, "contexts.json"),
            idFactory: () => context.ctxId!,
        });
        await registry.initialize();
        await registry.create({ instance: "demo", principal: "local", workspace: "/workspace" });
        const fake = createInteractionGateway();
        const now = new Date().toISOString();
        let goalId = "goal-old";
        fake.waits.push({
            automaticRecovery: true,
            createdAt: now,
            createdByCtxId: context.ctxId!,
            detachedAt: now,
            goalId: "goal-old",
            goalStepId: "work",
            kind: "tmux",
            resolvedAt: now,
            result: { task: { id: "tmux-goal-fence", status: "0" } },
            status: "resolved",
            targetId: "tmux-goal-fence",
            updatedAt: now,
            waitId: "wait-goal-fence",
        });
        Object.assign(fake.gateway, {
            async goalContinuation() { return { goal: null }; },
            async manageGoal() { return undefined; },
            async readGoal() {
                return {
                    autoContinueExhausted: false,
                    continuationCount: 0,
                    continuationDue: false,
                    continuationDueAt: "2099-01-01T00:00:00.000Z",
                    continuationPending: false,
                    createdAt: now,
                    goalId,
                    lastAgentActivityAt: now,
                    lastProgressAt: now,
                    maxContinuations: 0,
                    objective: goalId,
                    revision: 1,
                    status: "active" as const,
                    steps: [{ id: "work", status: "active" as const, text: "Work" }],
                    updatedAt: now,
                };
            },
        });
        const handler = new McpEndpointHandlerInteraction({ contextRegistry: registry, gateway: fake.gateway, instanceName: "demo" });
        const token = await openWorkspace(handler);
        const claim = await handler.call(
            "workspace_reentry",
            { action: "claim", claimId: "claim-goal-fence", intent: "automatic", token },
            context,
            "call-goal-fence-claim",
        ) as { claimed?: boolean };
        assert.equal(claim.claimed, true);
        goalId = "goal-new";
        const validated = await handler.call(
            "workspace_reentry",
            { action: "validate", claimId: "claim-goal-fence", token },
            context,
            "call-goal-fence-validate",
        ) as { valid?: boolean };
        assert.equal(validated.valid, false);
        assert.equal(fake.waits.find((wait) => wait.waitId === "wait-goal-fence")?.status, "consumed");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("server re-entry arbiter owns Goal retry reset before explicit delivery", async () => {
    const root = await createTestTempDirectory("reentry-goal-retry");
    try {
        const registry = new McpContextRegistry({
            filePath: join(root, "contexts.json"),
            idFactory: () => context.ctxId!,
        });
        await registry.initialize();
        await registry.create({ instance: "demo", principal: "local", workspace: "/workspace" });
        const fake = createInteractionGateway();
        const actions: string[] = [];
        const now = new Date().toISOString();
        const goal = {
            autoContinueExhausted: false,
            continuationCount: 1,
            continuationDue: false,
            continuationDueAt: "2099-01-01T00:00:00.000Z",
            continuationPending: false,
            createdAt: now,
            goalId: "goal-retry",
            lastAgentActivityAt: now,
            lastProgressAt: now,
            maxContinuations: 0,
            objective: "Retry Goal",
            revision: 1,
            status: "active" as const,
            steps: [{ id: "work", status: "active" as const, text: "Work" }],
            updatedAt: now,
        };
        Object.assign(fake.gateway, {
            async goalContinuation(_instance: string, input: GoalContinuationInput) {
                actions.push(input.action);
                return { goal };
            },
            async manageGoal() { return goal; },
            async readGoal() { return goal; },
        });
        const handler = new McpEndpointHandlerInteraction({ contextRegistry: registry, gateway: fake.gateway, instanceName: "demo" });
        const token = await openWorkspace(handler);
        const result = await handler.call(
            "workspace_reentry",
            { action: "claim", claimId: "claim-goal-retry", intent: "goal-retry", sourceId: "goal-retry", token },
            context,
            "call-goal-retry",
        ) as { claimed?: boolean; delivery?: { kind?: string; sourceId?: string } };
        assert.equal(result.claimed, true);
        assert.equal(result.delivery?.kind, "explicit");
        assert.equal(result.delivery?.sourceId, "goal-retry");
        assert.deepEqual(actions, ["reset"]);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("server re-entry arbiter gives one-shot Wait priority over repeatable Goal continuation", async () => {
    const root = await createTestTempDirectory("reentry-wait-goal-priority");
    try {
        let nowMs = Date.parse("2026-09-03T01:00:00.000Z");
        const registry = new McpContextRegistry({
            filePath: join(root, "contexts.json"),
            idFactory: () => context.ctxId!,
            now: () => nowMs,
        });
        await registry.initialize();
        await registry.create({ instance: "demo", principal: "local", workspace: "/workspace" });
        const fake = createInteractionGateway();
        let goalClaimId: string | undefined;
        let goalAttempted = false;
        let goalContinuationCount = 0;
        let goalClaimCalls = 0;
        const goalSnapshot = () => ({
            autoContinueExhausted: false,
            continuationAttemptedAt: goalAttempted ? new Date(nowMs).toISOString() : undefined,
            continuationCount: goalContinuationCount,
            continuationDue: goalClaimId === undefined,
            continuationDueAt: new Date(nowMs).toISOString(),
            continuationMessageId: goalClaimId === undefined ? undefined : `goal-message-${goalClaimId}`,
            continuationPending: goalClaimId !== undefined,
            continuationUncertain: false,
            createdAt: "2026-09-03T00:00:00.000Z",
            goalId: "goal-priority",
            lastAgentActivityAt: "2026-09-03T00:00:00.000Z",
            lastProgressAt: "2026-09-03T00:00:00.000Z",
            maxContinuations: 0,
            noActionStreak: 0,
            objective: "Keep working",
            progressEpoch: 0,
            revision: 1,
            stagnationStreak: 0,
            status: "active" as const,
            steps: [{ id: "work", status: "active" as const, text: "Work" }],
            updatedAt: new Date(nowMs).toISOString(),
        });
        Object.assign(fake.gateway, {
            async goalContinuation(_instance: string, input: GoalContinuationInput) {
                if (input.action === "claim") {
                    goalClaimCalls += 1;
                    if (goalClaimId !== undefined) return { claimed: false, goal: goalSnapshot() };
                    goalClaimId = input.claimId;
                    goalAttempted = false;
                    return {
                        claimed: true,
                        claimId: goalClaimId,
                        continuationCount: goalContinuationCount + 1,
                        goal: goalSnapshot(),
                    };
                }
                if (input.action === "validate") {
                    return { goal: goalSnapshot(), valid: goalClaimId === input.claimId };
                }
                if (input.action === "attempt") {
                    if (goalClaimId !== input.claimId) return { attempted: false, goal: goalSnapshot() };
                    goalAttempted = true;
                    return { attempted: true, goal: goalSnapshot(), messageId: `goal-message-${goalClaimId}` };
                }
                if (input.action === "report") {
                    if (goalClaimId !== input.claimId) throw new Error("goal claim mismatch");
                    if (input.accepted === true) goalContinuationCount += 1;
                    goalClaimId = undefined;
                    goalAttempted = false;
                    return { goal: goalSnapshot() };
                }
                if (input.action === "release") {
                    if (goalClaimId === input.claimId && !goalAttempted) goalClaimId = undefined;
                    return { goal: goalSnapshot(), released: true };
                }
                return { goal: goalSnapshot(), reset: true };
            },
            async manageGoal() {
                return goalSnapshot();
            },
            async readGoal() {
                return goalSnapshot();
            },
        });
        const now = new Date(nowMs).toISOString();
        fake.waits.push({
            automaticRecovery: true,
            createdAt: now,
            createdByCtxId: context.ctxId!,
            detachedAt: now,
            kind: "tmux",
            resolvedAt: now,
            result: { task: { id: "task-priority", status: "0" } },
            status: "resolved",
            targetId: "task-priority",
            updatedAt: now,
            waitId: "wait-priority",
        });
        const handler = new McpEndpointHandlerInteraction({
            contextRegistry: registry,
            gateway: fake.gateway,
            instanceName: "demo",
        });
        const token = await openWorkspace(handler);
        type ReentryResult = {
            attempted?: boolean;
            claimed?: boolean;
            delivery?: { kind?: string };
            valid?: boolean;
        };
        const call = (action: string, claimId: string, extra: Record<string, unknown> = {}) => handler.call(
            "workspace_reentry",
            { action, claimId, token, ...extra },
            context,
            `call-${action}-${claimId}`,
        ) as Promise<ReentryResult>;

        const waitClaim = await call("claim", "claim-wait", { intent: "automatic" });
        assert.equal(waitClaim.claimed, true);
        assert.equal(waitClaim.delivery?.kind, "wait");
        assert.equal(goalClaimCalls, 0, "Goal must not claim while a one-shot Wait can notify");
        assert.equal((await call("validate", "claim-wait")).valid, true);
        assert.equal((await call("attempt", "claim-wait")).attempted, true);
        await call("report", "claim-wait", { outcome: "rejected" });
        assert.equal(fake.waits.find((wait) => wait.waitId === "wait-priority")?.status, "consumed");

        const firstGoal = await call("claim", "claim-goal-1", { intent: "automatic" });
        assert.equal(firstGoal.claimed, true);
        assert.equal(firstGoal.delivery?.kind, "goal");
        assert.equal(goalClaimCalls, 1);
        assert.equal((await call("validate", "claim-goal-1")).valid, true);
        assert.equal((await call("attempt", "claim-goal-1")).attempted, true);
        await call("report", "claim-goal-1", { outcome: "accepted" });
        assert.equal(goalContinuationCount, 1);

        nowMs += 60_001;
        const secondGoal = await call("claim", "claim-goal-2", { intent: "automatic" });
        assert.equal(secondGoal.claimed, true, "Goal remains repeatable after the previous continuation lease expires");
        assert.equal(secondGoal.delivery?.kind, "goal");
        assert.equal(goalClaimCalls, 2);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Workspace tool metadata keeps the explicit reopen compatibility tool and app-only action tools", () => {
    const definitions = new McpToolCatalogInteraction().list();
    const adapter = new McpToolSchemaAdapter();
    const open = definitions.find((definition) => definition.name === "workspace_open");
    const answer = definitions.find((definition) => definition.name === "workspace_answer");
    const interrupt = definitions.find((definition) => definition.name === "workspace_interrupt");
    const recover = definitions.find((definition) => definition.name === "workspace_recover");
    const watch = definitions.find((definition) => definition.name === "workspace_watch");
    const reconnect = definitions.find((definition) => definition.name === "workspace_reconnect");
    const ask = definitions.find((definition) => definition.name === "workspace_ask");
    const goal = definitions.find((definition) => definition.name === "workspace_goal");
    const goalResume = definitions.find((definition) => definition.name === "workspace_resume");
    const goalStop = definitions.find((definition) => definition.name === "workspace_stop");

    assert.deepEqual([...new Set(definitions.map((definition) => definition.group))], ["workspace"]);
    assert.ok(open);
    assert.ok(answer);
    assert.ok(interrupt);
    assert.ok(recover);
    assert.ok(watch);
    assert.ok(reconnect);
    assert.ok(ask);
    assert.ok(goal);
    assert.equal(definitions.some((definition) => definition.name === "workspace_goal_continue"), false);
    assert.ok(goalResume);
    assert.ok(goalStop);
    assert.deepEqual((reconnect.inputSchema as { required?: string[] }).required, ["token"]);
    const adaptedOpen = adapter.toMcpTool(open, open.description);
    const adaptedAnswer = adapter.toMcpTool(answer, answer.description);
    const adaptedInterrupt = adapter.toMcpTool(interrupt, interrupt.description);
    const adaptedWatch = adapter.toMcpTool(watch, watch.description);
    assert.equal((adaptedOpen._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, workspaceAppResourceUri);
    assert.equal((adaptedOpen._meta as Record<string, unknown>)["ui/resourceUri"], workspaceAppResourceUri);
    assert.equal((adaptedOpen._meta as Record<string, unknown>)["openai/outputTemplate"], workspaceAppResourceUri);
    assert.equal((adaptedOpen._meta as Record<string, unknown>)["openai/widgetAccessible"], true);
    assert.deepEqual((adaptedAnswer._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    assert.deepEqual((adaptedInterrupt._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    assert.deepEqual((adaptedWatch._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    assert.deepEqual((reconnect?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    const recoveryInputSchema = recover.inputSchema as {
        properties?: { action?: { enum?: string[] }; claimId?: unknown; recoveryMessageId?: unknown };
        required?: string[];
    };
    assert.deepEqual(recoveryInputSchema.properties?.action?.enum, ["dismiss"]);
    assert.equal(recoveryInputSchema.properties?.claimId, undefined);
    assert.notEqual(recoveryInputSchema.properties?.recoveryMessageId, undefined);
    assert.deepEqual(recoveryInputSchema.required, ["action", "recoveryMessageId", "waitId", "token"]);
    const askInputSchema = ask.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
    };
    assert.equal(askInputSchema.properties?.taskId, undefined);
    assert.deepEqual(askInputSchema.required, ["question"]);
    assert.equal(ask._meta, undefined);
    assert.equal(goal._meta, undefined);
    assert.deepEqual((goalResume._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    assert.deepEqual((goalStop._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);

    const compatibilityDefinitions = new McpToolCatalogInteraction().list();
    const compatibilityOpen = compatibilityDefinitions.find((definition) => definition.name === "workspace_open");
    const compatibilitySnapshot = compatibilityDefinitions.find((definition) => definition.name === "workspace_snapshot");
    const compatibilityOpenSchema = compatibilityOpen?.outputSchema as {
        properties?: { ctxId?: unknown; tasks?: unknown };
    };
    const compatibilitySnapshotSchema = compatibilitySnapshot?.outputSchema as {
        properties?: {
            ctxId?: unknown;
            questions?: { items?: { properties?: Record<string, unknown> } };
            tasks?: { items?: { properties?: Record<string, unknown> } };
        };
    };
    assert.notEqual(compatibilityOpenSchema.properties?.ctxId, undefined);
    assert.equal(compatibilityOpenSchema.properties?.tasks, undefined);
    assert.notEqual(compatibilitySnapshotSchema.properties?.ctxId, undefined);
    assert.equal(compatibilitySnapshotSchema.properties?.tasks?.items?.properties?.ctxId, undefined);
    assert.equal(compatibilitySnapshotSchema.properties?.questions?.items?.properties?.createdByCtxId, undefined);
    assert.equal(compatibilitySnapshotSchema.properties?.questions?.items?.properties?.ownerCallId, undefined);
    assert.equal(compatibilitySnapshotSchema.properties?.questions?.items?.properties?.recoveryClaimId, undefined);
    assert.equal(compatibilityOpen?.description, open.description);
});

async function openWorkspace(handler: McpEndpointHandlerInteraction): Promise<string> {
    const opened = await handler.call("workspace_open", {}, context, "call-open");
    assert.ok(opened instanceof McpNativeToolResult);
    const meta = opened._meta?.["portable-devshell/workspace"] as { token?: unknown } | undefined;
    if (typeof meta?.token !== "string") throw new Error("workspace token missing");
    await handler.call("workspace_snapshot", { token: meta.token }, context, "call-snapshot");
    return meta.token;
}

function createInteractionGateway(): {
    created: Promise<WaitRecord>;
    gateway: McpInteractionGateway;
    waits: WaitRecord[];
} {
    const waits: WaitRecord[] = [];
    const pending = new Map<string, {
        reject(error: Error): void;
        resolve(record: WaitRecord): void;
    }>();
    let resolveCreated!: (record: WaitRecord) => void;
    const created = new Promise<WaitRecord>((resolve) => {
        resolveCreated = resolve;
    });

    const gateway = {
        async readTodo(_instance: string, input?: { taskId?: string }) {
            return input?.taskId === "task-1"
                ? {
                    items: [{ content: "Work", id: "item-1", status: "in_progress" }],
                    revision: 1,
                    summary: { completed: 0, total: 1 },
                    taskId: "task-1",
                    tasks: [{
                        completed: 0,
                        ctxId: context.ctxId,
                        revision: 1,
                        status: "in_progress",
                        taskId: "task-1",
                        title: "Task",
                        total: 1,
                        updatedAt: "2026-08-20T00:00:00.000Z",
                    }],
                    title: "Task"
                }
                : { items: [], revision: 0, summary: { completed: 0, total: 0 }, tasks: [] };
        },
        async createWait(_instance: string, input: WaitCreateInput) {
            const now = new Date().toISOString();
            const record: WaitRecord = {
                ...input,
                createdAt: now,
                status: "waiting",
                updatedAt: now,
                waitId: `wait-${waits.length + 1}`,
            };
            waits.push(record);
            resolveCreated(record);
            return structuredClone(record);
        },
        async waitForWait(_instance: string, waitId: string) {
            const existing = waits.find((entry) => entry.waitId === waitId);
            if (existing?.status === "resolved") return structuredClone(existing);
            return await new Promise<WaitRecord>((resolve, reject) => pending.set(waitId, { reject, resolve }));
        },
        async listWaits() {
            return structuredClone(waits);
        },
        async reattachWait(_instance: string, waitId: string, ownerCallId?: string) {
            const record = requireWait(waits, waitId);
            if (record.status !== "detached") throw new Error(`Wait ${waitId} is not detached.`);
            delete record.detachedAt;
            if (ownerCallId === undefined) delete record.ownerCallId;
            else record.ownerCallId = ownerCallId;
            record.status = "waiting";
            record.updatedAt = new Date().toISOString();
            return structuredClone(record);
        },
        async resolveWait(_instance: string, waitId: string, result?: JsonValue) {
            const record = requireWait(waits, waitId);
            Object.assign(record, {
                resolvedAt: new Date().toISOString(),
                result,
                status: "resolved" as const,
                updatedAt: new Date().toISOString(),
            });
            pending.get(waitId)?.resolve(structuredClone(record));
            pending.delete(waitId);
            return structuredClone(record);
        },
        async consumeWait(_instance: string, waitId: string) {
            const record = requireWait(waits, waitId);
            Object.assign(record, {
                consumedAt: new Date().toISOString(),
                status: "consumed" as const,
                updatedAt: new Date().toISOString(),
            });
            return structuredClone(record);
        },
        async claimWaitRecovery(_instance: string, waitId: string, claimId: string) {
            const record = requireWait(waits, waitId);
            if (record.status !== "resolved" || record.detachedAt === undefined) {
                throw new Error(`Wait ${waitId} cannot be recovered.`);
            }
            if (record.recoveryClaimId !== undefined && record.recoveryClaimId !== claimId) {
                throw new Error(`Wait ${waitId} recovery is already claimed.`);
            }
            record.recoveryClaimId = claimId;
            record.recoveryMessageId ??= `recovery-message-${claimId}`;
            record.recoveryClaimedAt = new Date().toISOString();
            record.updatedAt = record.recoveryClaimedAt;
            return structuredClone(record);
        },
        async dismissWaitRecovery(_instance: string, waitId: string, recoveryMessageId: string) {
            const record = requireWait(waits, waitId);
            if (
                record.status !== "resolved" || record.recoveryMessageAttemptedAt === undefined ||
                record.recoveryMessageSentAt !== undefined || record.recoveryMessageId !== recoveryMessageId
            ) throw new Error(`Wait ${waitId} cannot dismiss recovery.`);
            delete record.recoveryClaimId;
            delete record.recoveryClaimedAt;
            record.recoveryDismissedAt = new Date().toISOString();
            record.consumedAt = record.recoveryDismissedAt;
            record.status = "consumed";
            record.updatedAt = record.recoveryDismissedAt;
            return structuredClone(record);
        },
        async markWaitRecoveryAttempted(_instance: string, waitId: string, claimId: string, goalProgressEpoch?: number) {
            const record = requireWait(waits, waitId);
            if (record.recoveryClaimId !== claimId) throw new Error(`Wait ${waitId} recovery claim does not match.`);
            if (goalProgressEpoch !== undefined) record.recoveryGoalProgressEpoch = goalProgressEpoch;
            record.recoveryMessageAttemptedAt ??= new Date().toISOString();
            record.updatedAt = record.recoveryMessageAttemptedAt;
            return structuredClone(record);
        },
        async releaseWaitRecovery(_instance: string, waitId: string, claimId: string) {
            const record = requireWait(waits, waitId);
            if (record.recoveryClaimId !== claimId) throw new Error(`Wait ${waitId} recovery claim does not match.`);
            delete record.recoveryClaimId;
            delete record.recoveryClaimedAt;
            record.updatedAt = new Date().toISOString();
            return structuredClone(record);
        },
        async rejectWaitRecovery(_instance: string, waitId: string, claimId: string) {
            const record = requireWait(waits, waitId);
            if (record.recoveryClaimId !== claimId) throw new Error(`Wait ${waitId} recovery claim does not match.`);
            delete record.recoveryClaimId;
            delete record.recoveryClaimedAt;
            delete record.recoveryMessageAttemptedAt;
            delete record.recoveryMessageId;
            record.updatedAt = new Date().toISOString();
            return structuredClone(record);
        },
        async disableWaitRecovery(_instance: string, waitId: string) {
            const record = requireWait(waits, waitId);
            record.automaticRecovery = false;
            record.recoveryDisabledAt ??= new Date().toISOString();
            record.updatedAt = record.recoveryDisabledAt;
            return structuredClone(record);
        },
        async completeWaitRecovery(_instance: string, waitId: string, claimId: string) {
            const record = requireWait(waits, waitId);
            if (record.recoveryClaimId !== claimId) throw new Error(`Wait ${waitId} recovery claim does not match.`);
            if (record.recoveryMessageAttemptedAt === undefined) throw new Error(`Wait ${waitId} recovery was not marked attempted.`);
            delete record.recoveryClaimId;
            delete record.recoveryClaimedAt;
            record.consumedAt = new Date().toISOString();
            record.recoveryMessageSentAt = record.consumedAt;
            record.status = "consumed";
            record.updatedAt = record.consumedAt;
            return structuredClone(record);
        },
        async cancelWait(_instance: string, waitId: string) {
            const record = requireWait(waits, waitId);
            Object.assign(record, {
                cancelledAt: new Date().toISOString(),
                status: "cancelled" as const,
                updatedAt: new Date().toISOString(),
            });
            pending.get(waitId)?.reject(new Error(`Wait ${waitId} became cancelled.`));
            pending.delete(waitId);
            return structuredClone(record);
        },
        async detachWait(_instance: string, waitId: string) {
            const record = requireWait(waits, waitId);
            const detachedAt = new Date().toISOString();
            record.detachedAt = detachedAt;
            if (record.status === "waiting") record.status = "detached";
            else if (record.status !== "resolved") throw new Error(`Wait ${waitId} cannot be detached while ${record.status}.`);
            record.updatedAt = detachedAt;
            pending.get(waitId)?.resolve(structuredClone(record));
            pending.delete(waitId);
            return structuredClone(record);
        },
        async listApprovals() {
            return [];
        },
        async decideApproval() {
            throw new Error("No approval in this test");
        },
    } as unknown as McpInteractionGateway;

    return { created, gateway, waits };
}

function requireWait(waits: WaitRecord[], waitId: string): WaitRecord {
    const record = waits.find((entry) => entry.waitId === waitId);
    if (record === undefined) throw new Error(`missing wait ${waitId}`);
    return record;
}
