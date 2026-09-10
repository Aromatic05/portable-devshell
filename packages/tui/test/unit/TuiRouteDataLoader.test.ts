import assert from "node:assert/strict";
import test from "node:test";

import { TuiRouteDataLoader } from "../../src/runtime/route/TuiRouteDataLoader.js";
import { TuiAppStore } from "../../src/state/TuiAppStore.js";

test("Logs contexts route loads persisted logs on first entry", async () => {
    const store = new TuiAppStore();
    const refreshes: string[] = [];
    const loader = new TuiRouteDataLoader({
        session: {
            refreshLogsForInstance: async (instance: string) => {
                refreshes.push(instance);
            },
        } as never,
        store,
    });

    await loader.enter({
        instance: "alpha",
        route: { page: "logs", view: "contexts" },
        signal: new AbortController().signal,
    });

    assert.deepEqual(refreshes, ["alpha"]);
});

test("Logs context route loads logs and owns follow cleanup", async () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({
        instanceState: {
            alpha: {
                logs: [{
                    at: "2026-09-10T10:00:00.000Z",
                    ctxId: "ctx-alpha",
                    instanceName: "alpha",
                    message: "ready",
                    seq: 9,
                    stream: "stdout",
                }],
            },
        },
    });
    const refreshes: string[] = [];
    const loader = new TuiRouteDataLoader({
        session: {
            refreshLogsForInstance: async (instance: string) => {
                refreshes.push(instance);
            },
        } as never,
        store,
    });

    const cleanup = await loader.enter({
        instance: "alpha",
        route: {
            ctxId: "ctx-alpha",
            page: "logs",
            scope: "context",
            view: "context",
        },
        signal: new AbortController().signal,
    });

    assert.deepEqual(refreshes, ["alpha"]);
    assert.equal(store.getState().ui.logsFollowByInstance.alpha, true);
    assert.equal(typeof cleanup, "function");
    cleanup?.();
    assert.equal(store.getState().ui.logsFollowByInstance.alpha, false);
    assert.equal(store.getState().ui.logsPausedAtSeqByInstance.alpha, 9);
});
