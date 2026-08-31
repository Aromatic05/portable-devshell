import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { GoalContinuationInput, JsonValue, ToolCallContext, WaitCreateInput, WaitRecord } from "@portable-devshell/shared";
import {
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
        "workspace_question_answer",
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
        "workspace_question_answer",
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
        "workspace_question_answer",
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
        async readTodo() {
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
        "workspace_question_answer",
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
        "workspace_question_answer",
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
            "workspace_approval_decide",
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
        "workspace_question_answer",
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
        async readToolCalls() {
            return [{ callId: "call-running", inputSummary: "long command", instance: "demo", source: "mcp", startedAt: now, status: "running", toolName: "bash_run" }];
        },
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
        "workspace_question_answer",
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
        "workspace_wait_interrupt",
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
        "workspace_wait_interrupt",
        { token, waitId: "wait-tmux-race" },
        context,
        "call-interrupt-race",
    ) as { detached?: boolean };
    assert.equal(result.detached, true);
});

test("Workspace task control and detached-wait recovery use durable server state", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push({
        createdAt: now,
        createdByCtxId: context.ctxId!,
        detachedAt: now,
        kind: "tmux",
        resolvedAt: now,
        result: { task: { status: "0" } },
        status: "resolved",
        targetId: "tmux-task-1",
        taskId: "task-1",
        updatedAt: now,
        waitId: "wait-recover",
    });
    let controlled: { action?: string; ctxId?: string; taskId?: string } = {};
    let taskStatus = "in_progress";
    const gateway = Object.assign(fake.gateway, {
        async controlTodo(_instance: string, taskId: string, action: string, ctxId: string) {
            controlled = { action, ctxId, taskId };
            if (action === "pause") taskStatus = "paused";
            if (action === "resume") taskStatus = "in_progress";
            return { taskId };
        },
        async readTodo(_instance: string, input?: { taskId?: string }) {
            if (input?.taskId === "task-1") {
                return {
                    items: [],
                    revision: 1,
                    summary: { completed: 0, total: 1 },
                    taskId: "task-1",
                    tasks: [{ ctxId: context.ctxId, status: taskStatus, taskId: "task-1" }],
                    title: "Task"
                };
            }
            return {
                items: [],
                revision: 0,
                summary: { completed: 0, total: 0 },
                tasks: [{ ctxId: context.ctxId, status: taskStatus, taskId: "task-1" }],
            };
        },
        async readToolCalls() { return []; },
        async readWorkspaceEvents() { return { events: [], gap: false, lastSeq: 1 }; },
    }) as McpWorkspaceGateway;
    const handler = new McpEndpointHandlerInteraction({ gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    await handler.call(
        "workspace_task_control",
        { action: "pause", revision: 1, taskId: "task-1", token },
        context,
        "call-control",
    );
    assert.deepEqual(controlled, { action: "pause", ctxId: context.ctxId, taskId: "task-1" });

    await assert.rejects(handler.call(
        "workspace_wait_recover",
        { action: "claim", token, waitId: "wait-recover" },
        context,
        "call-recover-paused",
    ), /not available for automatic recovery/);

    await handler.call(
        "workspace_task_control",
        { action: "resume", revision: 1, taskId: "task-1", token },
        context,
        "call-resume",
    );

    const recovered = await handler.call(
        "workspace_wait_recover",
        { action: "claim", token, waitId: "wait-recover" },
        context,
        "call-recover",
    ) as { claimId: string; kind: string; recoveryMessageId: string; result: JsonValue; targetId: string; taskId: string; waitId: string };
    assert.match(recovered.claimId, /^recovery-/u);
    assert.match(recovered.recoveryMessageId, /^recovery-message-/u);
    assert.deepEqual({ ...recovered, claimId: "<claim>" }, {
        claimId: "<claim>",
        kind: "tmux",
        recoveryMessageId: recovered.recoveryMessageId,
        result: { task: { status: "0" } },
        taskId: "task-1",
        targetId: "tmux-task-1",
        waitId: "wait-recover",
    });
    const claimed = fake.waits.find((entry) => entry.waitId === "wait-recover");
    assert.equal(claimed?.status, "resolved");
    assert.equal(claimed?.recoveryClaimId, recovered.claimId);

    const attempted = await handler.call(
        "workspace_wait_recover",
        { action: "attempt", claimId: recovered.claimId, token, waitId: "wait-recover" },
        context,
        "call-recover-attempt",
    ) as { attempted: true; recoveryMessageAttemptedAt: string; recoveryMessageId: string; waitId: string };
    assert.equal(attempted.attempted, true);
    assert.equal(attempted.waitId, "wait-recover");
    assert.equal(claimed?.recoveryMessageAttemptedAt, attempted.recoveryMessageAttemptedAt);

    const sent = await handler.call(
        "workspace_wait_recover",
        { action: "sent", claimId: recovered.claimId, token, waitId: "wait-recover" },
        context,
        "call-recover-sent",
    ) as { recoveryMessageId: string; recoveryMessageSentAt: string; sent: true; waitId: string };
    assert.equal(sent.sent, true);
    assert.equal(sent.waitId, "wait-recover");
    assert.equal(claimed?.recoveryMessageSentAt, sent.recoveryMessageSentAt);
    assert.deepEqual(await handler.call(
        "workspace_wait_recover",
        { action: "sent", claimId: recovered.claimId, token, waitId: "wait-recover" },
        context,
        "call-recover-sent-again",
    ), sent);

    await assert.rejects(handler.call(
        "workspace_wait_recover",
        { action: "claim", token, waitId: "wait-recover" },
        context,
        "call-recover-duplicate",
    ), /already claimed/u);

    assert.deepEqual(await handler.call(
        "workspace_wait_recover",
        { action: "release", claimId: recovered.claimId, token, waitId: "wait-recover" },
        context,
        "call-recover-release",
    ), { released: true, waitId: "wait-recover" });
    assert.equal(claimed?.recoveryClaimId, undefined);

    const reclaimed = await handler.call(
        "workspace_wait_recover",
        { action: "claim", token, waitId: "wait-recover" },
        context,
        "call-recover-again",
    ) as { claimId: string };
    assert.deepEqual(await handler.call(
        "workspace_wait_recover",
        { action: "complete", claimId: reclaimed.claimId, token, waitId: "wait-recover" },
        context,
        "call-recover-complete",
    ), {
        completed: true,
        kind: "tmux",
        targetId: "tmux-task-1",
        waitId: "wait-recover",
    });
    assert.equal(claimed?.status, "consumed");
});

test("Workspace detached-wait recovery accepts an active Goal without Todo", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push({
        createdAt: now,
        createdByCtxId: context.ctxId!,
        detachedAt: now,
        goalId: "goal-recover",
        kind: "tmux",
        resolvedAt: now,
        result: { task: { status: "0" } },
        status: "resolved",
        targetId: "tmux-goal",
        updatedAt: now,
        waitId: "wait-goal-recover",
    });
    let goalStatus = "stopped";
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
                createdAt: now,
                goalId: "goal-recover",
                lastAgentActivityAt: now,
                maxContinuations: 10,
                objective: "Recover Goal work",
                revision: 1,
                status: goalStatus,
                steps: [{ id: "work", status: "active", text: "Wait for background work" }],
                updatedAt: now,
            };
        },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    await assert.rejects(handler.call(
        "workspace_wait_recover",
        { action: "claim", token, waitId: "wait-goal-recover" },
        context,
        "call-goal-recover-stopped",
    ), /not available for automatic recovery/u);

    goalStatus = "active";
    const recovered = await handler.call(
        "workspace_wait_recover",
        { action: "claim", token, waitId: "wait-goal-recover" },
        context,
        "call-goal-recover",
    ) as { claimId: string; goalId: string; waitId: string };
    assert.equal(recovered.goalId, "goal-recover");
    assert.equal(recovered.waitId, "wait-goal-recover");
    assert.match(recovered.claimId, /^recovery-/u);
});

test("Workspace detached-wait recovery revalidates an associated task before dispatch attempt", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push({
        createdAt: now,
        createdByCtxId: context.ctxId!,
        detachedAt: now,
        kind: "tmux",
        resolvedAt: now,
        result: { task: { status: "0" } },
        status: "resolved",
        targetId: "tmux-race",
        taskId: "task-race",
        updatedAt: now,
        waitId: "wait-race",
    });
    let taskStatus = "in_progress";
    const gateway = Object.assign(fake.gateway, {
        async readTodo() {
            return {
                items: [],
                revision: 1,
                summary: { completed: 0, total: 1 },
                tasks: [{ ctxId: context.ctxId, status: taskStatus, taskId: "task-race" }],
            };
        },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    const claimed = await handler.call(
        "workspace_wait_recover",
        { action: "claim", token, waitId: "wait-race" },
        context,
        "call-race-claim",
    ) as { claimId: string };

    taskStatus = "paused";
    await assert.rejects(
        handler.call(
            "workspace_wait_recover",
            { action: "attempt", claimId: claimed.claimId, token, waitId: "wait-race" },
            context,
            "call-race-attempt",
        ),
        /not available for automatic recovery/u,
    );
    assert.equal(fake.waits.find((entry) => entry.waitId === "wait-race")?.recoveryMessageAttemptedAt, undefined);
});

test("Workspace detached-wait recovery accepts Context-only durable state", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push({
        createdAt: now,
        createdByCtxId: context.ctxId!,
        detachedAt: now,
        kind: "question",
        resolvedAt: now,
        result: { answer: "continue" },
        status: "resolved",
        targetId: "question-context-only",
        updatedAt: now,
        waitId: "wait-context-only",
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    const recovered = await handler.call(
        "workspace_wait_recover",
        { action: "claim", token, waitId: "wait-context-only" },
        context,
        "call-context-only-recover",
    ) as { claimId: string; kind: string; result: JsonValue; waitId: string };
    assert.equal(recovered.kind, "question");
    assert.deepEqual(recovered.result, { answer: "continue" });
    assert.equal(recovered.waitId, "wait-context-only");
    assert.match(recovered.claimId, /^recovery-/u);
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
        /active Live Workspace/i,
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
        "workspace_question_answer",
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
    await assert.rejects(held, /active Live Workspace/i);
    assert.equal(fake.waits.length, 0);
});

test("workspace_goal start requires an active Workspace", async () => {
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
        /active Live Workspace/u,
    );
    assert.equal(starts, 0);

    const opened = await handler.call("workspace_open", {}, context, "call-open");
    assert.ok(opened instanceof McpNativeToolResult);
    const meta = opened._meta?.["portable-devshell/workspace"] as { token?: unknown } | undefined;
    if (typeof meta?.token !== "string") throw new Error("workspace token missing");
    await assert.rejects(
        handler.call("workspace_goal", start, context, "call-goal-open-only"),
        /active Live Workspace/u,
    );
    assert.equal(starts, 0);

    await handler.call("workspace_snapshot", { token: meta.token }, context, "call-snapshot");
    await handler.call("workspace_goal", start, context, "call-goal-start");
    assert.equal(starts, 1);
});

test("Workspace can resume a blocked Goal through the app-only control", async () => {
    const fake = createInteractionGateway();
    const actions: string[] = [];
    Object.assign(fake.gateway, {
        async goalContinuation() {
            return { goal: null };
        },
        async manageGoal(_instance: string, input: { action: string }) {
            actions.push(input.action);
            return input.action === "resume"
                ? { goalId: "goal-1", objective: "Resume work", status: "active", steps: [] }
                : undefined;
        },
        async readGoal() {
            return { goalId: "goal-1", objective: "Resume work", status: "blocked", steps: [] };
        },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    const result = await handler.call(
        "workspace_goal_resume",
        { goalId: "goal-1", revision: 1, token },
        context,
        "call-goal-resume",
    ) as { goal?: { status?: string } };
    assert.deepEqual(actions, ["resume"]);
    assert.equal(result.goal?.status, "active");
});

test("Workspace Goal continuation is unavailable while the current Context still has a detached wait", async () => {
    const fake = createInteractionGateway();
    const continuationInputs: GoalContinuationInput[] = [];
    Object.assign(fake.gateway, {
        async goalContinuation(_instance: string, input: GoalContinuationInput) {
            continuationInputs.push({ ...input });
            return { claimed: false, goal: null };
        },
        async manageGoal() {
            return undefined;
        },
        async readGoal() {
            return undefined;
        },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);
    fake.waits.push({
        createdAt: "2026-08-20T00:00:00.000Z",
        createdByCtxId: context.ctxId!,
        detachedAt: "2026-08-20T00:01:00.000Z",
        kind: "tmux",
        status: "detached",
        targetId: "task-long",
        updatedAt: "2026-08-20T00:01:00.000Z",
        waitId: "wait-long",
    });

    await handler.call(
        "workspace_goal_continue",
        { action: "claim", available: true, claimId: "claim-1", token },
        context,
        "call-goal-continue",
    );

    assert.equal(continuationInputs.length, 1);
    assert.equal(continuationInputs[0]?.available, false);
});

test("Workspace Goal continuation rechecks live tool activity before every dispatch phase", async () => {
    const fake = createInteractionGateway();
    const continuationInputs: GoalContinuationInput[] = [];
    Object.assign(fake.gateway, {
        async goalContinuation(_instance: string, input: GoalContinuationInput) {
            continuationInputs.push({ ...input });
            return { claimed: false, goal: null };
        },
        async manageGoal() {
            return undefined;
        },
        async readGoal() {
            return undefined;
        },
        async readToolCalls() {
            return [{
                callId: "call-running",
                ctxId: context.ctxId,
                inputSummary: "long command",
                instance: "demo",
                source: "mcp",
                startedAt: "2026-08-30T00:00:00.000Z",
                status: "running",
                toolName: "bash_run",
            }];
        },
        async readWorkspaceEvents() {
            return { events: [], gap: false, lastSeq: 0 };
        },
    });
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    await handler.call(
        "workspace_goal_continue",
        { action: "validate", available: true, claimId: "claim-running", token },
        context,
        "call-goal-validate-running",
    );
    await handler.call(
        "workspace_goal_continue",
        { action: "attempt", available: true, claimId: "claim-running", token },
        context,
        "call-goal-attempt-running",
    );
    await handler.call(
        "workspace_goal_continue",
        { action: "suppress", token },
        context,
        "call-goal-suppress-running",
    );

    assert.equal(continuationInputs.length, 3);
    assert.equal(continuationInputs[0]?.available, false);
    assert.equal(continuationInputs[1]?.available, false);
    assert.equal(continuationInputs[2]?.action, "suppress");
    assert.equal(continuationInputs[2]?.available, undefined);
});

test("Workspace tool metadata keeps the explicit reopen compatibility tool and app-only action tools", () => {
    const definitions = new McpToolCatalogInteraction().list();
    const adapter = new McpToolSchemaAdapter();
    const open = definitions.find((definition) => definition.name === "workspace_open");
    const answer = definitions.find((definition) => definition.name === "workspace_question_answer");
    const interrupt = definitions.find((definition) => definition.name === "workspace_wait_interrupt");
    const recover = definitions.find((definition) => definition.name === "workspace_wait_recover");
    const watch = definitions.find((definition) => definition.name === "workspace_watch");
    const reconnect = definitions.find((definition) => definition.name === "workspace_reconnect");
    const ask = definitions.find((definition) => definition.name === "workspace_ask");
    const goal = definitions.find((definition) => definition.name === "workspace_goal");
    const goalResume = definitions.find((definition) => definition.name === "workspace_goal_resume");
    const goalStop = definitions.find((definition) => definition.name === "workspace_goal_stop");

    assert.deepEqual([...new Set(definitions.map((definition) => definition.group))], ["workspace"]);
    assert.ok(open);
    assert.ok(answer);
    assert.ok(interrupt);
    assert.ok(recover);
    assert.ok(watch);
    assert.ok(reconnect);
    assert.ok(ask);
    assert.ok(goal);
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
        properties?: { action?: { enum?: string[] } };
    };
    assert.deepEqual(recoveryInputSchema.properties?.action?.enum, ["claim", "attempt", "sent", "complete", "release", "dismiss"]);
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
    assert.match(open.description, /re-present or restore/u);
    assert.match(open.description, /environ_info normally bootstraps/u);
    assert.match(goal.description, /environ_info normally bootstraps the Live Workspace/u);
    assert.match(ask.description, /environ_info normally bootstraps the Live Workspace/u);

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
                    items: [],
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
        async markWaitRecoveryAttempted(_instance: string, waitId: string, claimId: string) {
            const record = requireWait(waits, waitId);
            if (record.recoveryClaimId !== claimId) throw new Error(`Wait ${waitId} recovery claim does not match.`);
            record.recoveryMessageAttemptedAt ??= new Date().toISOString();
            record.updatedAt = record.recoveryMessageAttemptedAt;
            return structuredClone(record);
        },
        async markWaitRecoverySent(_instance: string, waitId: string, claimId: string) {
            const record = requireWait(waits, waitId);
            if (record.recoveryClaimId !== claimId) throw new Error(`Wait ${waitId} recovery claim does not match.`);
            if (record.recoveryMessageAttemptedAt === undefined) throw new Error(`Wait ${waitId} recovery was not marked attempted.`);
            record.recoveryMessageSentAt ??= new Date().toISOString();
            record.updatedAt = record.recoveryMessageSentAt;
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
        async completeWaitRecovery(_instance: string, waitId: string, claimId: string) {
            const record = requireWait(waits, waitId);
            if (record.recoveryClaimId !== claimId) throw new Error(`Wait ${waitId} recovery claim does not match.`);
            if (record.recoveryMessageSentAt === undefined) throw new Error(`Wait ${waitId} recovery has not been durably marked sent.`);
            delete record.recoveryClaimId;
            delete record.recoveryClaimedAt;
            record.consumedAt = new Date().toISOString();
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
