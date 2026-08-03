import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type ContextMessageRecord,
    type OperationalOverview,
} from "@portable-devshell/shared";

import {
    TuiRenderScheduler,
    TuiAppStore,
    selectMainScreenModel,
} from "../../src/testing.ts";

test("TuiAppStore keeps page, instance, and expanded boxes stable across events", () => {
    const store = new TuiAppStore({ maxRawEvents: 2 });

    store.setConnectionState("connected");
    store.replaceInstances([
        { enabled: true, mcpEnabled: false, name: "alpha" },
        { enabled: true, mcpEnabled: true, name: "beta" },
    ]);
    store.setSelectedPage("logs");
    store.setSelectedInstance("beta");
    store.toggleExpanded("logs:beta:logs");
    store.replaceSnapshot({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 2,
        name: asInstanceName("beta"),
        ready: true,
        status: "ready",
    });
    store.applyEvent({
        destination: asInstanceName("beta"),
        id: "log-appended-3",
        name: "log.appended",
        payload: {
            at: "2026-07-09T00:00:03.000Z",
            data: {
                bytes: 8,
                stream: "stdout",
                tail: "payload",
            },
        },
        seq: 3,
    });

    const state = store.getState();

    assert.equal(state.connection.status, "connected");
    assert.equal(state.ui.selectedPage, "logs");
    assert.equal(state.ui.selectedInstance, "beta");
    assert.equal(state.ui.expandedBoxes["logs:beta:logs"], true);
    assert.equal(state.logsByInstance.beta?.length, 1);
    assert.equal(state.lastSeqByInstance.beta, 3);
    assert.equal(state.globalDerived.connectedInstanceCount, 1);
});

test("TuiRenderScheduler batches multiple store updates into one render notification", async () => {
    const store = new TuiAppStore();
    const scheduler = new TuiRenderScheduler(store, 5);
    let renderCount = 0;

    const unsubscribe = scheduler.subscribe(() => {
        renderCount += 1;
    });

    store.setConnectionState("connected");
    store.setSelectedPage("logs");
    store.setSelectedPage("help");

    await new Promise((resolve) => setTimeout(resolve, 20));

    unsubscribe();
    scheduler.dispose();

    assert.equal(renderCount, 1);
    assert.equal(scheduler.getSnapshot().ui.selectedPage, "help");
});

test("TuiRenderScheduler redraws visible Overview and Audit context message changes", async () => {
    const store = new TuiAppStore();
    store.replaceInstances([
        { enabled: true, mcpEnabled: true, name: "alpha" },
    ]);
    store.setSelectedInstance("alpha");
    const scheduler = new TuiRenderScheduler(store, 2);
    let renders = 0;
    const unsubscribe = scheduler.subscribe(() => {
        renders += 1;
    });

    store.setSelectedPage("overview");
    await delay(10);
    renders = 0;
    store.replaceOperationalOverview(emptyOverview());
    await delay(10);
    assert.equal(renders, 1);

    store.setSelectedPage("audit");
    await delay(10);
    renders = 0;
    store.replaceContextMessages("alpha", [contextMessage("message-1")]);
    await delay(10);
    assert.equal(renders, 1);

    unsubscribe();
    scheduler.dispose();
});

test("Audit page renders control-owned tool calls from live events", () => {
    const store = new TuiAppStore();
    store.replaceInstances([
        { enabled: true, mcpEnabled: true, name: "alpha" },
    ]);
    store.setSelectedInstance("alpha");
    store.setSelectedPage("audit");

    store.applyEvent({
        destination: asInstanceName("alpha"),
        id: "tool-running-1",
        name: "toolCall.running",
        payload: {
            at: "2026-07-15T00:00:00.000Z",
            data: {
                callId: "control-call-1",
                ctxId: "ctx-control",
                input: {},
                inputSummary: "{}",
                requestId: "request-control",
                source: "mcp",
                startedAt: "2026-07-15T00:00:00.000Z",
                status: "running",
                toolName: "todo_read",
            },
        },
        seq: 1,
    });
    store.applyEvent({
        destination: asInstanceName("alpha"),
        id: "tool-completed-2",
        name: "toolCall.completed",
        payload: {
            at: "2026-07-15T00:00:01.000Z",
            data: {
                callId: "control-call-1",
                completedAt: "2026-07-15T00:00:01.000Z",
                output: { revision: 3 },
                source: "mcp",
                startedAt: "2026-07-15T00:00:00.000Z",
                status: "completed",
                toolName: "todo_read",
            },
        },
        seq: 2,
    });

    const record = store.getState().toolCallsByInstance.alpha?.[0];
    assert.equal(record?.toolName, "todo_read");
    assert.equal(record?.status, "completed");
    assert.equal(record?.ctxId, "ctx-control");
    assert.deepEqual(record?.output, { revision: 3 });
    assert.equal(record?.requestId, "request-control");

    const contexts = selectMainScreenModel(store.getState());
    assert.equal(contexts.boxes[0]?.id, "audit-context:ctx-control");
    store.pushRoute({
        ctxId: "ctx-control",
        page: "audit",
        scope: "context",
        view: "context",
    });
    const calls = selectMainScreenModel(store.getState());
    assert.equal(calls.boxes[0]?.id, "audit-call:control-call-1");
    assert.equal(calls.boxes[0]?.title, "todo_read · completed");
    store.toggleExpanded(calls.boxes[0]!.expandedKey);
    const expanded = selectMainScreenModel(store.getState()).boxes[0];
    assert.equal(
        expanded?.expandedLines.some(
            (line) => line.text === "Context ctx-control",
        ),
        false,
    );
    assert.equal(
        expanded?.expandedLines.some((line) => line.text.trimStart().startsWith("Output")),
        true,
    );
});

test("TuiAppStore bounds live logs and tool calls per instance", () => {
    const store = new TuiAppStore();
    store.replaceInstances([
        { enabled: true, mcpEnabled: true, name: "alpha" },
    ]);

    for (let index = 1; index <= 150; index += 1) {
        store.applyEvent({
            destination: asInstanceName("alpha"),
            id: `tool-${index}`,
            name: "toolCall.running",
            payload: {
                at: new Date(index).toISOString(),
                data: {
                    callId: `call-${index}`,
                    inputSummary: "{}",
                    source: "mcp",
                    startedAt: new Date(index).toISOString(),
                    status: "running",
                    toolName: "bash_run",
                },
            },
            seq: index,
        });
    }

    for (let index = 151; index <= 300; index += 1) {
        store.applyEvent({
            destination: asInstanceName("alpha"),
            id: `log-${index}`,
            name: "log.appended",
            payload: {
                at: new Date(index).toISOString(),
                data: {
                    bytes: 1,
                    stream: "stdout",
                    tail: String(index),
                },
            },
            seq: index,
        });
    }

    assert.equal(store.getState().toolCallsByInstance.alpha?.length, 100);
    assert.equal(store.getState().logsByInstance.alpha?.length, 100);
});

test("TuiAppStore does not publish an unchanged OAuth approval collection", () => {
    const store = new TuiAppStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
        notifications += 1;
    });

    store.replaceOAuthApprovals([]);
    store.replaceOAuthApprovals([]);

    unsubscribe();
    assert.equal(notifications, 0);
});

test("TuiRenderScheduler ignores updates outside the visible page and instance", async () => {
    const store = new TuiAppStore();
    store.replaceInstances([
        { enabled: true, mcpEnabled: true, name: "alpha" },
        { enabled: true, mcpEnabled: true, name: "beta" },
    ]);
    store.setSelectedPage("help");
    store.setSelectedInstance("alpha");
    const scheduler = new TuiRenderScheduler(store, 2);
    let renderCount = 0;
    const unsubscribe = scheduler.subscribe(() => {
        renderCount += 1;
    });

    store.replaceToolCalls("alpha", [toolCall("alpha-help")]);
    await delay(10);
    assert.equal(renderCount, 0);

    store.setSelectedPage("audit");
    await delay(10);
    renderCount = 0;

    store.replaceToolCalls("beta", [toolCall("beta-audit")]);
    await delay(10);
    assert.equal(renderCount, 0);

    store.replaceToolCalls("alpha", [toolCall("alpha-audit")]);
    await delay(10);
    assert.equal(renderCount, 1);

    unsubscribe();
    scheduler.dispose();
});

test("Audit page creates expensive input and output detail only for expanded records", () => {
    const store = new TuiAppStore();
    store.replaceInstances([
        { enabled: true, mcpEnabled: true, name: "alpha" },
    ]);
    store.setSelectedInstance("alpha");
    store.setSelectedPage("audit");
    store.replaceToolCalls("alpha", [
        {
            ...toolCall("large-output"),
            input: { command: "x".repeat(20_000) },
            output: { stdout: "y".repeat(20_000) },
        },
    ]);

    const contexts = selectMainScreenModel(store.getState()).boxes;
    assert.equal(contexts[0]?.id, "audit-scope:unscoped");

    store.replaceToolCalls("alpha", [
        {
            ...toolCall("large-output"),
            ctxId: "ctx-large",
            input: { command: "x".repeat(20_000) },
            output: { stdout: "y".repeat(20_000) },
        },
    ]);
    store.pushRoute({
        ctxId: "ctx-large",
        page: "audit",
        scope: "context",
        view: "context",
    });
    const collapsed = selectMainScreenModel(store.getState()).boxes[0];
    assert.equal(collapsed?.expanded, false);
    assert.deepEqual(collapsed?.expandedLines, []);

    store.toggleExpanded(collapsed!.expandedKey);
    const expanded = selectMainScreenModel(store.getState()).boxes[0];
    assert.equal(expanded?.expanded, true);
    assert.equal(
        expanded?.expandedLines.some((line) => line.text.trimStart().startsWith("Input")),
        true,
    );
    assert.equal(
        expanded?.expandedLines.some((line) => line.text.trimStart().startsWith("Output")),
        true,
    );
});

function toolCall(callId: string) {
    return {
        callId,
        inputSummary: "{}",
        instance: asInstanceName(callId.startsWith("beta") ? "beta" : "alpha"),
        source: "mcp" as const,
        startedAt: "2026-07-28T00:00:00.000Z",
        status: "completed" as const,
        toolName: "bash_run",
    };
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function emptyOverview(): OperationalOverview {
    return {
        activity: [],
        alerts: [],
        controller: { pid: 1, uptimeSeconds: 1 },
        counts: {
            activeTodos: 0,
            failedCalls24h: 0,
            instancesAttention: 0,
            instancesCritical: 0,
            instancesReady: 0,
            instancesTotal: 0,
            pendingApprovals: 0,
        },
        generatedAt: "2026-07-31T00:00:00.000Z",
        health: "healthy",
        instances: [],
        todos: [],
    };
}

function contextMessage(id: string): ContextMessageRecord {
    return {
        createdAt: "2026-07-31T00:00:00.000Z",
        ctxId: "ctx-a",
        id,
        instance: "alpha",
        status: "pending",
        text: "Review this context",
    };
}
