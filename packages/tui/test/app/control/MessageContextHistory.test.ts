import assert from "node:assert/strict";
import test from "node:test";

import { TuiRouteDataLoader } from "../../../src/app/control/Route.ts";
import type { TuiDomainSession } from "../../../src/app/control/Client.ts";
import { TuiAppStore } from "../../../src/state/store/App.ts";
import { TuiKeyDispatcher } from "../../../src/interaction/Input.ts";
import { selectTuiMessageEntries, renderTuiMessageHistoryLines } from "../../../src/view/page/activity/messages/Projection.ts";
import { TuiTestDomains } from "../../support/DomainHarness.ts";

test("TUI Messages thread loads and releases only its scoped Context history", async () => {
    const loaded: string[] = [];
    const domains = {
        instances: {
            refresh: async () => { loaded.push("instances"); },
            state: { instances: [{ name: "alpha" }] },
        },
        context: { refresh: async () => { loaded.push("registry"); } },
        messageHistory: {
            load: async () => { loaded.push("preview"); },
            loadContext: async (instance: string, ctxId: string) => {
                loaded.push(`context:${instance}:${ctxId}`);
            },
            clearContext: (instance: string, ctxId: string) => {
                loaded.push(`clear:${instance}:${ctxId}`);
            },
        },
        messagePreferences: { refresh: async () => { loaded.push("preferences"); } },
        messages: { load: async () => { loaded.push("messages"); } },
    } as unknown as TuiDomainSession;
    const loader = new TuiRouteDataLoader({ domains, store: new TuiAppStore() });
    const signal = new AbortController().signal;
    const cleanup = await loader.enter({ instance: "alpha", route: {
        page: "messages", view: "thread", instance: "alpha", ctxId: "ctx-old",
    }, signal });
    assert.ok(loaded.includes("preview"));
    assert.equal(loaded.at(-1), "context:alpha:ctx-old");
    if (typeof cleanup === "function") cleanup();
    assert.equal(loaded.at(-1), "clear:alpha:ctx-old");
});

test("TUI Messages projects selected Context history and exposes its older-page shortcut", () => {
    const domains = new TuiTestDomains();
    domains.setMessageHistory("alpha", [{
        createdAt: "2026-09-01T00:00:00Z", ctxId: "ctx-other",
        id: "preview", kind: "comment", text: "Wrong preview entry", status: "delivered",
    }]);
    domains.messageHistory.patch({ context: {
        instance: "alpha", ctxId: "ctx-old", historyBefore: "oldest", loading: false,
        historyExhausted: false, entries: [{
            createdAt: "2026-09-01T00:00:00Z", ctxId: "ctx-old",
            id: "scoped", kind: "comment", text: "Scoped message survives", status: "delivered",
        }],
    } });

    assert.deepEqual(selectTuiMessageEntries(domains.reader, "alpha", "ctx-old").map((entry) => entry.text),
        ["Scoped message survives"]);
    const lines = renderTuiMessageHistoryLines(domains.reader, "alpha", "ctx-old", 80);
    assert.match(lines[0]?.text ?? "", /l load older/u);
    assert.ok(lines.some((line) => line.text.includes("Scoped message survives")));
    assert.equal(lines.some((line) => line.text.includes("Wrong preview entry")), false);
    const keys = new TuiKeyDispatcher();
    assert.deepEqual(keys.dispatch("mainBoxes", { input: "l", key: {} }), [{ type: "history.loadOlder" }]);
});
