import assert from "node:assert/strict";
import test from "node:test";

import { TuiRouteDataLoader } from "../../../src/app/control/Route.ts";
import type { TuiDomainSession } from "../../../src/app/control/Client.ts";
import { TuiAppStore } from "../../../src/state/store/App.ts";
import { TuiKeyDispatcher } from "../../../src/interaction/Input.ts";

test("TUI Audit route loads Context-scoped history without replacing the instance preview", async () => {
    const loaded: string[] = [];
    const domains = {
        context: { refresh: async () => { loaded.push("registry"); } },
        runtime: () => ({ load: async () => {}, readLogs: async () => {} }),
        approval: () => ({ load: async () => {} }),
        toolCalls: {
            load: async (instance: string) => { loaded.push(`preview:${instance}`); },
            loadContext: async (instance: string, ctxId: string) => {
                loaded.push(`context:${instance}:${ctxId}`);
            },
        },
        messageHistory: { refreshInstance: async () => {} },
        messages: { refreshInstance: async () => {} },
    } as unknown as TuiDomainSession;
    const loader = new TuiRouteDataLoader({ domains, store: new TuiAppStore() });
    const signal = new AbortController().signal;

    await loader.enter({
        instance: "alpha", route: { page: "audit", view: "context", scope: "context", ctxId: "ctx-one" }, signal,
    });
    assert.deepEqual(loaded, ["registry", "preview:alpha", "context:alpha:ctx-one"]);

    loaded.length = 0;
    await loader.enter({
        instance: "alpha", route: { page: "audit", view: "context", scope: "context", ctxId: "ctx-two" }, signal,
    });
    assert.deepEqual(loaded, ["registry", "preview:alpha", "context:alpha:ctx-two"]);

    loaded.length = 0;
    await loader.enter({ instance: "alpha", route: { page: "audit", view: "contexts" }, signal });
    assert.deepEqual(loaded, ["registry", "preview:alpha"]);
});

test("TUI Audit has a keyboard command to page the selected Context", () => {
    const keys = new TuiKeyDispatcher();
    assert.deepEqual(keys.dispatch("mainBoxes", { input: "l", key: {} }), [{ type: "history.loadOlder" }]);
});
