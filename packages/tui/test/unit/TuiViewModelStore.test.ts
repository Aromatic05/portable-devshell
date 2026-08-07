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
    store.patchControlReadModel({ instances: [
        { enabled: true, mcpEnabled: false, name: "alpha" },
        { enabled: true, mcpEnabled: true, name: "beta" },
    ] });
    store.setSelectedPage("logs");
    store.setSelectedInstance("beta");
    store.toggleExpanded("logs:beta:logs");
    store.patchControlSnapshot({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 2,
        name: asInstanceName("beta"),
        ready: true,
        status: "ready",
    });
    store.patchControlReadModel({ instanceState: { ["beta"]: { logs: [{
        at: "2026-07-09T00:00:03.000Z",
        bytes: 8,
        instance: "beta",
        receivedAt: "2026-07-09T00:00:03.000Z",
        seq: 3,
        stream: "stdout",
        tail: "payload",
    }] } } });
    store.applyInstanceEvent({
        at: "2026-07-09T00:00:03.000Z",
        instanceName: asInstanceName("beta"),
        seq: 3,
        type: "log.appended",
    });

    const state = store.getState();

    assert.equal(state.connection.status, "connected");
    assert.equal(state.ui.selectedPage, "logs");
    assert.equal(state.ui.selectedInstance, "beta");
    assert.equal(state.ui.expandedBoxes["logs:beta:logs"], true);
    assert.equal(state.readModel.instanceState.beta?.logs.length, 1);
    assert.equal(state.rawEvents.at(-1)?.seq, 3);
    assert.equal(state.globalDerived.connectedInstanceCount, 1);
});

test("TuiRenderScheduler batches multiple store updates into one render notification", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const store = new TuiAppStore();
    const scheduler = new TuiRenderScheduler(store, 5);
    let renderCount = 0;

    const unsubscribe = scheduler.subscribe(() => {
        renderCount += 1;
    });

    store.setConnectionState("connected");
    store.setSelectedPage("logs");
    store.setSelectedPage("help");

    assert.equal(renderCount, 0);
    t.mock.timers.tick(5);

    unsubscribe();
    scheduler.dispose();

    assert.equal(renderCount, 1);
    assert.equal(scheduler.getSnapshot().ui.selectedPage, "help");
});

test("TuiRenderScheduler redraws visible Overview and Audit context message changes", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const store = new TuiAppStore();
    store.patchControlReadModel({ instances: [
        { enabled: true, mcpEnabled: true, name: "alpha" },
    ] });
    store.setSelectedInstance("alpha");
    const scheduler = new TuiRenderScheduler(store, 2);
    let renders = 0;
    const unsubscribe = scheduler.subscribe(() => {
        renders += 1;
    });

    store.setSelectedPage("overview");
    t.mock.timers.tick(2);
    renders = 0;
    store.patchControlReadModel({ overview: emptyOverview() });
    assert.equal(renders, 0);
    t.mock.timers.tick(2);
    assert.equal(renders, 1);

    store.setSelectedPage("audit");
    t.mock.timers.tick(2);
    renders = 0;
    store.patchControlReadModel({ instanceState: { ["alpha"]: { contextMessages: [contextMessage("message-1")] } } });
    assert.equal(renders, 0);
    t.mock.timers.tick(2);
    assert.equal(renders, 1);

    unsubscribe();
    scheduler.dispose();
});

test("TuiAppStore does not publish an unchanged OAuth approval collection", () => {
    const store = new TuiAppStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
        notifications += 1;
    });

    store.patchControlReadModel({ oauthApprovals: [] });
    store.patchControlReadModel({ oauthApprovals: [] });

    unsubscribe();
    assert.equal(notifications, 0);
});

test("TuiRenderScheduler ignores updates outside the visible page and instance", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const store = new TuiAppStore();
    store.patchControlReadModel({ instances: [
        { enabled: true, mcpEnabled: true, name: "alpha" },
        { enabled: true, mcpEnabled: true, name: "beta" },
    ] });
    store.setSelectedPage("help");
    store.setSelectedInstance("alpha");
    const scheduler = new TuiRenderScheduler(store, 2);
    let renderCount = 0;
    const unsubscribe = scheduler.subscribe(() => {
        renderCount += 1;
    });

    store.patchControlReadModel({ instanceState: { ["alpha"]: { toolCalls: [toolCall("alpha-help")] } } });
    assert.equal(renderCount, 0);

    store.setSelectedPage("audit");
    t.mock.timers.tick(2);
    renderCount = 0;

    store.patchControlReadModel({ instanceState: { ["beta"]: { toolCalls: [toolCall("beta-audit")] } } });
    assert.equal(renderCount, 0);

    store.patchControlReadModel({ instanceState: { ["alpha"]: { toolCalls: [toolCall("alpha-audit")] } } });
    assert.equal(renderCount, 0);
    t.mock.timers.tick(2);
    assert.equal(renderCount, 1);

    unsubscribe();
    scheduler.dispose();
});

test("Audit page creates expensive input and output detail only for expanded records", () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({ instances: [
        { enabled: true, mcpEnabled: true, name: "alpha" },
    ] });
    store.setSelectedInstance("alpha");
    store.setSelectedPage("audit");
    store.patchControlReadModel({ instanceState: { ["alpha"]: { toolCalls: [
        {
            ...toolCall("large-output"),
            input: { command: "x".repeat(20_000) },
            output: { stdout: "y".repeat(20_000) },
        },
    ] } } });

    const contexts = selectMainScreenModel(store.getState()).boxes;
    assert.equal(contexts[0]?.id, "audit-scope:unscoped");

    store.patchControlReadModel({ instanceState: { ["alpha"]: { toolCalls: [
        {
            ...toolCall("large-output"),
            ctxId: "ctx-large",
            input: { command: "x".repeat(20_000) },
            output: { stdout: "y".repeat(20_000) },
        },
    ] } } });
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
