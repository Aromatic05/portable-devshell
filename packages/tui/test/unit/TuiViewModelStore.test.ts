import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { RenderScheduler, TuiAppStore } from "../../dist/index.js";

test("TuiAppStore keeps page, instance, and expanded boxes stable across events", () => {
    const store = new TuiAppStore({ maxRawEvents: 2 });

    store.setConnectionState("connected");
    store.replaceInstances([
        { mcpEnabled: false, name: "alpha" },
        { mcpEnabled: true, name: "beta" }
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
        event: "log.appended",
        payload: {
            at: "2026-07-09T00:00:03.000Z",
            data: {
                bytes: 8,
                stream: "stdout",
                tail: "payload"
            }
        },
        seq: 3,
        target: {
            instance: asInstanceName("beta"),
            kind: "instance"
        },
        type: "event"
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

test("RenderScheduler batches multiple store updates into one render notification", async () => {
    const store = new TuiAppStore();
    const scheduler = new RenderScheduler(store, 5);
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
