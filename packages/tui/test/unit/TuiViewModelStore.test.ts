import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { TuiRenderScheduler, TuiAppStore, selectMainScreenModel } from "../../src/testing.ts";

test("TuiAppStore keeps page, instance, and expanded boxes stable across events", () => {
    const store = new TuiAppStore({ maxRawEvents: 2 });

    store.setConnectionState("connected");
    store.replaceInstances([
        { enabled: true, mcpEnabled: false, name: "alpha" },
        { enabled: true, mcpEnabled: true, name: "beta" }
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
        status: "ready"
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
                tail: "payload"
            }
        },
        seq: 3
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

test("Audit page renders control-owned tool calls from live events", () => {
    const store = new TuiAppStore();
    store.replaceInstances([{ enabled: true, mcpEnabled: true, name: "alpha" }]);
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
                toolName: "todo_read"
            }
        },
        seq: 1
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
                toolName: "todo_read"
            }
        },
        seq: 2
    });

    const record = store.getState().toolCallsByInstance.alpha?.[0];
    assert.equal(record?.toolName, "todo_read");
    assert.equal(record?.status, "completed");
    assert.equal(record?.ctxId, "ctx-control");
    assert.deepEqual(record?.output, { revision: 3 });
    assert.equal(record?.requestId, "request-control");

    const audit = selectMainScreenModel(store.getState());
    assert.equal(audit.boxes[0]?.id, "audit-control-call-1");
    assert.equal(audit.boxes[0]?.title, "todo_read · completed");
    assert.equal(audit.boxes[0]?.expandedLines.some((line) => line.text === "ctxId ctx-control"), true);
    assert.equal(audit.boxes[0]?.expandedLines.some((line) => line.text.startsWith("output ")), true);
});
