import assert from "node:assert/strict";
import test from "node:test";
import { TuiRouteDataLoader, TuiRouteLifecycleController } from "../../../src/app/control/Route.ts";
import { TuiDomainHarness } from "../../support/DomainHarness.ts";
import { TuiAppStore } from "../../../src/state/store/App.ts";
import { deferred } from "../../support/Round6Harness.ts";

for (const page of ["messages", "audit"] as const) {
    test(`C05 ${page}: late A1 cleanup cannot release the newly entered A2 Context`, async () => {
        const harness = new TuiDomainHarness();
        const domains = harness.value;
        const store = new TuiAppStore();
        const firstStarted = deferred<void>();
        const firstDone = deferred<void>();
        const secondStarted = deferred<void>();
        let enters = 0;
        let selected = false;
        let clears = 0;
        const history = page === "messages" ? domains.messageHistory : domains.toolCalls;
        history.loadContext = async () => {
            selected = true;
            enters++;
            if (enters === 1) { firstStarted.resolve(); await firstDone.promise; }
            else secondStarted.resolve();
        };
        history.clearContext = () => { selected = false; clears++; };
        const loader = new TuiRouteDataLoader({ domains, store });
        const controller = new TuiRouteLifecycleController({ store, onEnter: (context) => loader.enter(context) });
        store.setSelectedInstance("alpha");
        store.setSelectedPage(page);
        const route = page === "messages"
            ? { page, view: "thread" as const, instance: "alpha", ctxId: "A" }
            : { page, view: "context" as const, scope: "context" as const, ctxId: "A" };
        store.pushRoute(route);
        controller.start();
        await firstStarted.promise;
        store.popRoute();
        store.pushRoute(route);
        await secondStarted.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        firstDone.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(selected, true);
        assert.equal(enters, 2);
        assert.equal(clears, 0);
        controller.stop();
        assert.equal(selected, false);
        assert.equal(clears, 1);
    });
}
