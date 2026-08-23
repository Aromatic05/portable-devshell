import assert from "node:assert/strict";
import test from "node:test";

import type { GoalContinuationInput, JsonValue, ToolCallContext, WaitCreateInput, WaitRecord } from "@portable-devshell/shared";
import {
    McpEndpointHandlerInteraction,
    McpNativeToolResult,
    McpToolCatalogInteraction,
    McpToolSchemaAdapter,
    type McpInteractionGateway,
    type McpWorkspaceGateway,
    workspaceAppResourceUri,
} from "@portable-devshell/mcp/testing";

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
    await handler.call("workspace_open", {}, context, "call-open");

    const reconnected = await handler.call("workspace_reconnect", {}, context, "call-reconnect");

    assert.ok(reconnected instanceof McpNativeToolResult);
    assert.equal((reconnected.structuredContent as { ctxId?: string }).ctxId, context.ctxId);
    const meta = reconnected._meta?.["portable-devshell/workspace"] as { token?: string } | undefined;
    const token = meta?.token;
    assert.equal(typeof token, "string");
    if (token === undefined) throw new Error("Workspace reconnect token is missing.");
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

test("Workspace reconnect rotates the App token and fences the old token", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const firstToken = await openWorkspace(handler);
    const reconnected = await handler.call("workspace_reconnect", {}, context, "call-reconnect");
    assert.ok(reconnected instanceof McpNativeToolResult);
    const secondToken = (reconnected._meta?.["portable-devshell/workspace"] as { token: string }).token;
    assert.notEqual(secondToken, firstToken);
    await assert.rejects(
        handler.call("workspace_snapshot", { token: firstToken }, context, "call-stale-snapshot"),
        /authorization is invalid/i,
    );
    await assert.doesNotReject(handler.call(
        "workspace_snapshot",
        { token: secondToken },
        context,
        "call-current-snapshot",
    ));
});

test("Workspace snapshot projects only compact task and background state", async () => {
    const fake = createInteractionGateway();
    const now = new Date().toISOString();
    fake.waits.push({
        createdAt: now,
        createdByCtxId: context.ctxId!,
        kind: "tmux",
        status: "detached",
        targetId: "tmux-task-1",
        taskId: "task-1",
        updatedAt: now,
        waitId: "wait-tmux",
    });
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
        async readToolCalls() { throw new Error("Workspace snapshot should not read tool history."); },
        async readWorkspaceEvents() {
            return { events: [], gap: false, lastSeq: 7 };
        },
    }) as McpWorkspaceGateway;
    const handler = new McpEndpointHandlerInteraction({ gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);

    const result = await handler.call("workspace_snapshot", { token }, context, "call-app");
    assert.ok(result instanceof McpNativeToolResult);
    const snapshot = result.structuredContent as {
        background?: Array<Record<string, unknown>>;
        currentEvent?: Record<string, unknown> | null;
        cursor?: number;
        tasks?: Array<Record<string, unknown>>;
    };
    assert.equal(snapshot.cursor, 7);
    assert.equal(snapshot.background?.[0]?.tmuxTaskId, "tmux-task-1");
    assert.equal(snapshot.background?.[0]?.taskId, "task-1");
    assert.equal(snapshot.currentEvent, null);
    assert.equal(Object.hasOwn(snapshot, "activity"), false);
    assert.equal(Object.hasOwn(snapshot.tasks?.[0] ?? {}, "ctxId"), false);
    assert.equal(Object.hasOwn(snapshot, "waits"), false);
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
        { action: "pause", taskId: "task-1", token },
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
        { action: "resume", taskId: "task-1", token },
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

test("workspace_watch heartbeat advances its cursor without forcing a snapshot", async () => {
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
    assert.deepEqual(result.structuredContent, { changed: false, cursor: 11 });
});

test("workspace_ask refuses to hold a call before Workspace is open", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
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
        /active Workspace App/i,
    );
    assert.equal(fake.waits.length, 0);
});

test("workspace_ask refuses to create a held call after the Workspace App lease expires", async () => {
    const fake = createInteractionGateway();
    let now = 1_000;
    const handler = new McpEndpointHandlerInteraction({
        gateway: fake.gateway,
        instanceName: "demo",
        now: () => now,
        workspaceLivenessMs: 60_000,
    });
    await openWorkspace(handler);
    now += 60_001;

    await assert.rejects(
        handler.call(
            "workspace_ask",
            { question: "Is anyone still there?" },
            context,
            "call-agent-stale",
        ),
        /active Workspace App/i,
    );
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
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const start = {
        action: "start",
        objective: "Visible Goal",
        steps: [{ id: "work", text: "Do the work" }],
    };

    await assert.rejects(
        handler.call("workspace_goal", start, context, "call-goal-headless"),
        /active Workspace App/u,
    );
    assert.equal(starts, 0);

    const opened = await handler.call("workspace_open", {}, context, "call-open");
    assert.ok(opened instanceof McpNativeToolResult);
    const meta = opened._meta?.["portable-devshell/workspace"] as { token?: unknown } | undefined;
    if (typeof meta?.token !== "string") throw new Error("workspace token missing");
    await assert.rejects(
        handler.call("workspace_goal", start, context, "call-goal-open-only"),
        /active Workspace App/u,
    );
    assert.equal(starts, 0);

    await handler.call("workspace_snapshot", { token: meta.token }, context, "call-snapshot");
    await handler.call("workspace_goal", start, context, "call-goal-start");
    assert.equal(starts, 1);
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

test("Workspace tool metadata uses one render tool and app-only action tools", () => {
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
    assert.ok(goalStop);
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
    assert.deepEqual(recoveryInputSchema.properties?.action?.enum, ["claim", "sent", "complete", "release"]);
    const askInputSchema = ask.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
    };
    assert.equal(askInputSchema.properties?.taskId, undefined);
    assert.deepEqual(askInputSchema.required, ["question"]);
    assert.equal(ask._meta, undefined);
    assert.equal(goal._meta, undefined);
    assert.deepEqual((goalStop._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    assert.match(open.description, /visible App is attached to this tool result/u);
    assert.match(open.description, /Workspace state remains durable/u);

    const sessionDefinitions = new McpToolCatalogInteraction().list(false);
    const sessionOpen = sessionDefinitions.find((definition) => definition.name === "workspace_open");
    const sessionSnapshot = sessionDefinitions.find((definition) => definition.name === "workspace_snapshot");
    const sessionOpenSchema = sessionOpen?.outputSchema as {
        properties?: { ctxId?: unknown; tasks?: unknown };
    };
    const sessionSnapshotSchema = sessionSnapshot?.outputSchema as {
        properties?: {
            ctxId?: unknown;
            questions?: { items?: { properties?: Record<string, unknown> } };
            tasks?: { items?: { properties?: Record<string, unknown> } };
        };
    };
    assert.equal(sessionOpenSchema.properties?.ctxId, undefined);
    assert.equal(sessionOpenSchema.properties?.tasks, undefined);
    assert.equal(sessionSnapshotSchema.properties?.ctxId, undefined);
    assert.equal(sessionSnapshotSchema.properties?.tasks?.items?.properties?.ctxId, undefined);
    assert.equal(sessionSnapshotSchema.properties?.questions?.items?.properties?.createdByCtxId, undefined);
    assert.equal(sessionSnapshotSchema.properties?.questions?.items?.properties?.ownerCallId, undefined);
    assert.equal(sessionSnapshotSchema.properties?.questions?.items?.properties?.recoveryClaimId, undefined);
    assert.doesNotMatch(sessionOpen?.description ?? "", /ctxId/u);
    assert.match(sessionOpen?.description ?? "", /visible App is attached to this tool result/u);
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
        async markWaitRecoverySent(_instance: string, waitId: string, claimId: string) {
            const record = requireWait(waits, waitId);
            if (record.recoveryClaimId !== claimId) throw new Error(`Wait ${waitId} recovery claim does not match.`);
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
            Object.assign(record, {
                detachedAt: new Date().toISOString(),
                status: "detached" as const,
                updatedAt: new Date().toISOString(),
            });
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
