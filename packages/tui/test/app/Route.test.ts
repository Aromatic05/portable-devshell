import assert from "node:assert/strict";
import test from "node:test";
import { TuiAppStore } from "../../src/state/store/App.js";
import { TuiRouteLifecycleController } from "../../src/app/control/Route.ts";

{
    async function flush(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    test("route lifecycle aborts stale loads and runs route cleanup exactly once", async () => {
        const store = new TuiAppStore();
        store.setSelectedInstance("alpha");
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
