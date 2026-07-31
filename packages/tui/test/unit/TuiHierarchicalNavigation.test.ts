import assert from "node:assert/strict";
import test from "node:test";

import {
    currentTuiRoute,
    selectBreadcrumbSegments,
    selectMainScrollKey,
    TuiAppStore,
    tuiPageEntries
} from "../../src/testing.ts";

function createStore(): TuiAppStore {
    const store = new TuiAppStore();
    store.replaceInstances([
        { enabled: true, mcpEnabled: true, name: "alpha" },
        { enabled: true, mcpEnabled: true, name: "beta" }
    ]);
    store.setSelectedInstance("alpha");
    store.replaceToolCalls("alpha", [{
        callId: "call-2",
        ctxId: "ctx-a",
        inputSummary: "{}",
        instance: "alpha" as never,
        source: "mcp",
        startedAt: "2026-07-31T00:00:00.000Z",
        status: "completed",
        toolName: "bash_run"
    }]);
    return store;
}

test("route stacks are isolated by feature page and instance and restore route view state", () => {
    const store = createStore();

    store.setSelectedPage("audit");
    assert.deepEqual(currentTuiRoute(store.getState()), { page: "audit", view: "contexts" });
    store.setMainFocusId("audit-context:ctx-a");
    store.setScrollOffset(selectMainScrollKey(store.getState()), 7);
    store.pushRoute({ ctxId: "ctx-a", page: "audit", view: "context" });
    store.setMainFocusId("audit-call:call-2");
    store.setScrollOffset(selectMainScrollKey(store.getState()), 11);

    store.setSelectedPage("logs");
    store.pushRoute({ page: "logs", sourceId: "control", view: "stream" });
    store.setMainFocusId("log-entry:18");

    store.setSelectedPage("audit");
    assert.deepEqual(currentTuiRoute(store.getState()), { ctxId: "ctx-a", page: "audit", view: "context" });
    assert.equal(store.getState().ui.mainFocusId, "audit-call:call-2");
    assert.equal(store.getState().ui.scrollOffsets[selectMainScrollKey(store.getState())], 11);

    assert.equal(store.popRoute(), true);
    assert.deepEqual(currentTuiRoute(store.getState()), { page: "audit", view: "contexts" });
    assert.equal(store.getState().ui.mainFocusId, "audit-context:ctx-a");
    assert.equal(store.getState().ui.scrollOffsets[selectMainScrollKey(store.getState())], 7);

    store.setSelectedInstance("beta");
    assert.deepEqual(currentTuiRoute(store.getState()), { page: "audit", view: "contexts" });
    assert.equal(store.getState().ui.mainFocusId, undefined);

    store.setSelectedInstance("alpha");
    assert.deepEqual(currentTuiRoute(store.getState()), { page: "audit", view: "contexts" });
    assert.equal(store.getState().ui.mainFocusId, "audit-context:ctx-a");
});

test("resource refresh removes invalid trailing routes instead of retaining a blank detail page", () => {
    const store = createStore();
    store.setSelectedPage("audit");
    store.replaceToolCalls("alpha", [{
        callId: "call-1",
        ctxId: "ctx-a",
        inputSummary: "{}",
        instance: "alpha" as never,
        source: "mcp",
        startedAt: "2026-07-31T00:00:00.000Z",
        status: "completed",
        toolName: "bash_run"
    }]);
    store.pushRoute({ ctxId: "ctx-a", page: "audit", view: "context" });
    store.pushRoute({ callId: "call-1", ctxId: "ctx-a", page: "audit", view: "call" });

    store.replaceToolCalls("alpha", []);

    assert.deepEqual(currentTuiRoute(store.getState()), { page: "audit", view: "contexts" });
});

test("footer breadcrumb follows the route stack and excludes overlay state", () => {
    const store = createStore();
    store.setSelectedPage("audit");
    store.replaceToolCalls("alpha", [{
        callId: "bash_run",
        ctxId: "ctx-1234567890-abcdefghij",
        inputSummary: "{}",
        instance: "alpha" as never,
        source: "mcp",
        startedAt: "2026-07-31T00:00:00.000Z",
        status: "completed",
        toolName: "bash_run"
    }]);
    store.pushRoute({ ctxId: "ctx-1234567890-abcdefghij", page: "audit", view: "context" });
    store.pushRoute({ callId: "bash_run", ctxId: "ctx-1234567890-abcdefghij", page: "audit", view: "call" });
    store.setConfirmDialog({
        body: "Confirm action",
        confirmIntent: { type: "ui.cancel" },
        open: true,
        title: "Confirm"
    });

    assert.deepEqual(selectBreadcrumbSegments(store.getState()), [
        "audit",
        "alpha",
        "ctx-1234…ghij",
        "bash_run"
    ]);
});

test("connector and OAuth are represented by one Connections top-level page", () => {
    assert.deepEqual(
        tuiPageEntries.map((entry) => entry.id),
        ["overview", "instances", "config", "connections", "audit", "logs", "todo", "help", "terminal"]
    );
});
