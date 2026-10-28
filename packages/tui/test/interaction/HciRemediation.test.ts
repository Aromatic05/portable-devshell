import assert from "node:assert/strict";
import test from "node:test";
import { round6Tui, deferred } from "../support/Round6Harness.ts";
import { TuiKeyDispatcher } from "../../src/interaction/Input.ts";
import { readContextMessageDraft } from "../../src/state/editor/MessageDraft.ts";

for (const cached of [false, true]) {
    test(`OAuth approval refresh failure stays unknown with cached=${cached} and offers retry`, async () => {
        const reloads: string[] = [];
        const h = round6Tui({ onPageReload: async (page) => { reloads.push(page); } });
        h.store.setSelectedPage("connections");
        h.store.pushRoute({ page: "connections", view: "oauth", providerId: "default" });
        h.domains.mcp.patch({
            approvalFailure: new Error("approval service unavailable"),
            status: { authMode: "oauth2", running: true, oauthReady: true },
            approvals: cached ? [{
                approvalId: "request", kind: "registration", clientName: "Client", clientId: "client",
                createdAt: "2026-10-28T00:00:00Z", expiresAt: "2026-10-29T00:00:00Z",
                redirectUris: [], requestedScopes: [], requestedResources: [], status: "pending",
            }] : [],
        });
        assert.equal(h.model().boxes.some((box) => box.id === "oauth-empty"), false);
        assert.ok(h.model().boxes.find((box) => box.id === "oauth-runtime")?.collapsedLines.some((line) => line.text.includes("pending=unknown")));
        const failure = h.model().boxes.find((box) => box.id === "oauth-unavailable")!;
        assert.equal(failure.status, "warning");
        assert.equal(h.model().boxes.some((box) => box.id === "oauth-approval-request"), cached);
        assert.equal(failure.collapsedLines.some((line) => line.text.includes("out of date")), cached);
        h.store.toggleExpanded(failure.expandedKey);
        h.store.setMainFocusId(failure.id);
        h.store.setSelectedDetailLine(failure.expandedKey, "oauth-unavailable:oauth.retry");
        h.store.setFocusScope("boxDetail");
        assert.ok(h.model().boxes.find((box) => box.id === failure.id)?.expandedLines.some((line) => line.text.includes("approval service unavailable")));
        assert.equal(await h.dispatcher.dispatch({ type: "focus.activate" }), true);
        assert.deepEqual(reloads, ["connections"]);
        h.domains.mcp.patch({ approvalFailure: undefined, approvals: [] });
        assert.ok(h.model().boxes.some((box) => box.id === "oauth-empty"));
        assert.equal(h.model().boxes.some((box) => box.id === "oauth-unavailable"), false);
    });
}

test("Messages Ctrl+O loads the active thread from composer focus; plain letters remain text", async () => {
    const calls: string[][] = [];
    const h = round6Tui({ onMessageLoadOlder: async (instance, ctxId) => {
        calls.push([instance, ctxId]); return 2;
    } });
    h.store.setSelectedPage("messages");
    h.store.pushRoute({ page: "messages", view: "thread", instance: "alpha", ctxId: "thread" });
    await h.dispatcher.dispatch({ type: "contextMessage.edit" });
    assert.equal(h.store.getState().interaction.focusScope, "contextMessage");
    const keys = new TuiKeyDispatcher();
    await h.dispatcher.dispatchMany(keys.dispatch("contextMessage", { input: "l", key: {} }));
    await h.dispatcher.dispatchMany(keys.dispatch("contextMessage", { input: "o", key: {} }));
    assert.equal(readContextMessageDraft(h.store.getState(), "alpha", "thread"), "lo");
    assert.deepEqual(calls, []);
    await h.dispatcher.dispatchMany(keys.dispatch("contextMessage", { input: "o", key: { ctrl: true } }));
    assert.deepEqual(calls, [["alpha", "thread"]]);
    assert.equal(readContextMessageDraft(h.store.getState(), "alpha", "thread"), "lo");
    assert.equal(h.model().statusLine, "Loaded 2 older Comments and Reports.");
    h.store.setSelectedPage("instances");
    assert.equal(await h.dispatcher.dispatch({ type: "history.loadOlder" }), false);
    h.store.setSelectedPage("messages");
    h.store.popRoute();
    assert.equal(await h.dispatcher.dispatch({ type: "history.loadOlder" }), false);
    assert.deepEqual(calls, [["alpha", "thread"]]);
    assert.deepEqual(keys.dispatch("mainBoxes", { input: "o", key: { ctrl: true } }), [{ type: "history.loadOlder" }]);
});

test("Messages older-page completion cannot overwrite a different thread's status", async () => {
    const pending = deferred<number>();
    const entered = deferred<void>();
    const calls: string[][] = [];
    const h = round6Tui({ onMessageLoadOlder: async (instance, ctxId) => {
        calls.push([instance, ctxId]); entered.resolve(); return await pending.promise;
    } });
    h.store.setSelectedPage("messages");
    h.store.pushRoute({ page: "messages", view: "thread", instance: "alpha", ctxId: "first" });
    const loading = h.dispatcher.dispatch({ type: "history.loadOlder" });
    await entered.promise;
    h.store.pushRoute({ page: "messages", view: "thread", instance: "beta", ctxId: "second" });
    h.store.setScreenStatus("messages", "Second thread");
    pending.resolve(3);
    assert.equal(await loading, true);
    assert.deepEqual(calls, [["alpha", "first"]]);
    assert.equal(h.model().statusLine, "Second thread");
});
