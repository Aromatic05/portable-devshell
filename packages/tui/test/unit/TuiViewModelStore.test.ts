import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { RenderScheduler, TuiAppStore } from "../../dist/index.js";

test("TuiAppStore tracks connection, snapshots, lastSeq, and raw events", () => {
    const store = new TuiAppStore({ maxRawEvents: 2 });

    store.setConnectionState("connected");
    store.replaceInstances([{ mcpEnabled: false, name: "alpha" }]);
    store.replaceSnapshot({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 2,
        name: asInstanceName("alpha"),
        ready: true,
        status: "ready"
    });
    store.applyEvent({
        event: "toolCall.completed",
        payload: { callId: "call-3" },
        seq: 3,
        target: {
            instance: asInstanceName("alpha"),
            kind: "instance"
        },
        type: "event"
    });
    store.applyEvent({
        event: "toolCall.completed",
        payload: { callId: "call-3-duplicate" },
        seq: 3,
        target: {
            instance: asInstanceName("alpha"),
            kind: "instance"
        },
        type: "event"
    });
    store.applyEvent({
        event: "toolCall.completed",
        payload: { callId: "call-4" },
        seq: 4,
        target: {
            instance: asInstanceName("alpha"),
            kind: "instance"
        },
        type: "event"
    });

    const state = store.getState();

    assert.equal(state.connection.status, "connected");
    assert.equal(state.instances[0]?.name, "alpha");
    assert.equal(state.snapshotsByInstance.alpha?.status, "ready");
    assert.equal(state.lastSeqByInstance.alpha, 4);
    assert.equal(state.rawEvents.length, 2);
    assert.deepEqual(
        state.rawEvents.map((event) => event.seq),
        [3, 4]
    );
    assert.equal(state.globalDerived.connectedInstanceCount, 1);
});

test("RenderScheduler batches multiple store updates into one render notification", async () => {
    const store = new TuiAppStore();
    const scheduler = new RenderScheduler(store, 5);
    let renderCount = 0;

    const unsubscribe = scheduler.subscribe(() => {
        renderCount += 1;
    });

    store.setConnectionState("connected");
    store.setActivePanel("logs");
    store.setActivePanel("help");

    await new Promise((resolve) => setTimeout(resolve, 20));

    unsubscribe();
    scheduler.dispose();

    assert.equal(renderCount, 1);
    assert.equal(scheduler.getSnapshot().activePanel, "help");
});
