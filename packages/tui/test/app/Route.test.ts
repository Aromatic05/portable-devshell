import assert from "node:assert/strict";
import test from "node:test";
import { TuiRouteDataLoader } from "../../src/app/control/Route.js";
import { TuiAppStore } from "../../src/state/store/App.js";
import { TuiRouteLifecycleController } from "../../src/app/control/Route.ts";

{
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
}

{
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

test("route lifecycle aborts stale loads and runs route cleanup exactly once", async () => {
    const store = new TuiAppStore();
    store.patchControlReadModel({ instances: [
        { enabled: true, mcpEnabled: true, name: "alpha" },
    ] });
    store.setSelectedInstance("alpha");
    store.patchControlReadModel({ instanceState: { ["alpha"]: { toolCalls: [
        {
            callId: "call-1",
            ctxId: "ctx-a",
            inputSummary: "{}",
            instance: "alpha" as never,
            source: "mcp",
            startedAt: "2026-07-31T00:00:00.000Z",
            status: "completed",
            toolName: "bash_run",
        },
    ] } } });
    const entered: string[] = [];
    const aborted: string[] = [];
    const cleaned: string[] = [];
    const controller = new TuiRouteLifecycleController({
        onEnter: async ({ route, signal }) => {
            entered.push(`${route.page}/${route.view}`);
            signal.addEventListener(
                "abort",
                () => aborted.push(`${route.page}/${route.view}`),
                { once: true },
            );
            return () => cleaned.push(`${route.page}/${route.view}`);
        },
        store,
    });

    controller.start();
    await flush();
    store.setSelectedPage("audit");
    await flush();
    store.pushRoute({
        ctxId: "ctx-a",
        page: "audit",
        scope: "context",
        view: "context",
    });
    await flush();
    controller.stop();

    assert.deepEqual(entered, [
        "instances/list",
        "audit/contexts",
        "audit/context",
    ]);
    assert.deepEqual(aborted, [
        "instances/list",
        "audit/contexts",
        "audit/context",
    ]);
    assert.deepEqual(cleaned, [
        "instances/list",
        "audit/contexts",
        "audit/context",
    ]);
});

test("route lifecycle discards cleanup returned by a load that finishes after its route was left", async () => {
    const store = new TuiAppStore();
    let resolveFirst!: (cleanup: () => void) => void;
    const lateCleanup = new Promise<() => void>((resolve) => {
        resolveFirst = resolve;
    });
    let cleaned = 0;
    const controller = new TuiRouteLifecycleController({
        onEnter: async ({ route }) =>
            route.page === "instances" ? await lateCleanup : undefined,
        store,
    });

    controller.start();
    store.setSelectedPage("help");
    resolveFirst(() => {
        cleaned += 1;
    });
    await flush();
    controller.stop();

    assert.equal(cleaned, 1);
});
}
