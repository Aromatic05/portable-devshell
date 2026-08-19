import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue, ToolCallContext, WaitCreateInput, WaitRecord } from "@portable-devshell/shared";
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

test("ask_question holds the original call until the Workspace app answers", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);
    let settled = false;
    const held = handler.call(
        "ask_question",
        {
            allowText: false,
            choices: ["A", "B"],
            question: "Which implementation?",
            taskId: "task-1",
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

test("ask_question detaches durable wait state when the host cancels the held call", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    const token = await openWorkspace(handler);
    const controller = new AbortController();
    const held = handler.call(
        "ask_question",
        { question: "Still there?", taskId: "task-1" },
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
        taskId: "task-1",
        waitId: wait.waitId,
    });
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
        {},
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

test("Workspace snapshot projects live activity and background tasks without full tool payloads", async () => {
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
        async readToolCalls() {
            return [{
                callId: "call-1",
                ctxId: context.ctxId,
                input: { command: "secret full input" },
                inputSummary: "bash_run command",
                instance: "demo",
                output: { stdout: "secret full output" },
                source: "mcp" as const,
                startedAt: now,
                status: "running" as const,
                toolName: "bash_run",
            }];
        },
        async readWorkspaceEvents() {
            return { events: [], gap: false, lastSeq: 7 };
        },
    }) as McpWorkspaceGateway;
    const handler = new McpEndpointHandlerInteraction({ gateway, instanceName: "demo" });

    const result = await handler.call("workspace_snapshot", {}, context, "call-app");
    assert.ok(result instanceof McpNativeToolResult);
    const snapshot = result.structuredContent as {
        activity?: Array<Record<string, unknown>>;
        background?: Array<Record<string, unknown>>;
        currentEvent?: Record<string, unknown> | null;
        cursor?: number;
    };
    assert.equal(snapshot.cursor, 7);
    assert.equal(snapshot.background?.[0]?.tmuxTaskId, "tmux-task-1");
    assert.equal(snapshot.background?.[0]?.taskId, "task-1");
    assert.equal(snapshot.currentEvent, null);
    assert.equal(snapshot.activity?.[0]?.toolName, "bash_run");
    assert.equal("input" in (snapshot.activity?.[0] ?? {}), false);
    assert.equal("output" in (snapshot.activity?.[0] ?? {}), false);
});

test("Workspace can interrupt a held tmux wait without cancelling the tmux task", async () => {
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
        interrupted: true,
        status: "cancelled",
        tmuxTaskId: "tmux-task-1",
        waitId: "wait-tmux",
    });
    assert.equal(fake.waits[0]?.status, "cancelled");
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
                return { items: [], revision: 1, summary: { completed: 0, total: 1 }, taskId: "task-1", title: "Task" };
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
        { token, waitId: "wait-recover" },
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
        { token, waitId: "wait-recover" },
        context,
        "call-recover",
    );
    assert.deepEqual(recovered, {
        result: { task: { status: "0" } },
        taskId: "task-1",
        tmuxTaskId: "tmux-task-1",
        waitId: "wait-recover",
    });
    assert.equal(fake.waits.find((entry) => entry.waitId === "wait-recover")?.status, "consumed");
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

    const result = await handler.call("workspace_watch", { cursor: 0 }, context, "call-watch");
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

    const result = await handler.call("workspace_watch", { cursor: 7 }, context, "call-watch");
    assert.ok(result instanceof McpNativeToolResult);
    assert.deepEqual(result.structuredContent, { changed: false, cursor: 11 });
});

test("ask_question refuses to hold a call before Workspace is open", async () => {
    const fake = createInteractionGateway();
    const handler = new McpEndpointHandlerInteraction({ gateway: fake.gateway, instanceName: "demo" });
    await assert.rejects(
        handler.call(
            "ask_question",
            { question: "Invisible question?", taskId: "task-1" },
            context,
            "call-agent",
        ),
        /workspace_open/i,
    );
});

test("Workspace tool metadata uses one render tool and app-only action tools", () => {
    const definitions = new McpToolCatalogInteraction().list();
    const adapter = new McpToolSchemaAdapter();
    const open = definitions.find((definition) => definition.name === "workspace_open");
    const answer = definitions.find((definition) => definition.name === "workspace_question_answer");
    const interrupt = definitions.find((definition) => definition.name === "workspace_wait_interrupt");
    const watch = definitions.find((definition) => definition.name === "workspace_watch");
    const ask = definitions.find((definition) => definition.name === "ask_question");

    assert.ok(open);
    assert.ok(answer);
    assert.ok(interrupt);
    assert.ok(watch);
    assert.ok(ask);
    const adaptedOpen = adapter.toMcpTool(open, open.description);
    const adaptedAnswer = adapter.toMcpTool(answer, answer.description);
    const adaptedInterrupt = adapter.toMcpTool(interrupt, interrupt.description);
    const adaptedWatch = adapter.toMcpTool(watch, watch.description);
    assert.equal((adaptedOpen._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, workspaceAppResourceUri);
    assert.deepEqual((adaptedAnswer._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    assert.deepEqual((adaptedInterrupt._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    assert.deepEqual((adaptedWatch._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
    assert.equal(ask._meta, undefined);
});

async function openWorkspace(handler: McpEndpointHandlerInteraction): Promise<string> {
    const opened = await handler.call("workspace_open", {}, context, "call-open");
    assert.ok(opened instanceof McpNativeToolResult);
    const meta = opened._meta?.["portable-devshell/workspace"] as { token?: unknown } | undefined;
    if (typeof meta?.token !== "string") throw new Error("workspace token missing");
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
                ? { items: [], revision: 1, summary: { completed: 0, total: 1 }, taskId: "task-1", title: "Task" }
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
