import assert from "node:assert/strict";
import test from "node:test";

import {
    currentTuiRoute,
    selectBreadcrumbSegments,
    selectFooterShortcuts,
    selectMainScreenModel,
    selectMainScrollKey,
    TuiAppStore,
    TuiCommandDispatcherNavigation,
    tuiViewProjection,
    type TuiCommandDispatcherFocus,
    type TuiFocusManager,
} from "../../src/testing.ts";

function createStore(): TuiAppStore {
    const store = new TuiAppStore();
    store.patchControlReadModel({ instances: [
        { enabled: true, mcpEnabled: true, name: "alpha" },
        { enabled: true, mcpEnabled: true, name: "beta" },
    ] });
    store.setSelectedInstance("alpha");
    store.patchControlReadModel({ instanceState: { ["alpha"]: { toolCalls: [
        {
            callId: "call-2",
            ctxId: "ctx-a",
            inputSummary: "{}",
            instance: "alpha" as never,
            source: "mcp",
            startedAt: "2026-07-31T00:00:00.000Z",
            status: "completed",
            toolName: "bash_run",
        },
    ] } } });
    return store;
}

test("route stacks are isolated by feature page and instance and restore route view state", () => {
    const store = createStore();

    store.setSelectedPage("audit");
    assert.deepEqual(currentTuiRoute(store.getState()), {
        page: "audit",
        view: "contexts",
    });
    store.setMainFocusId("audit-context:ctx-a");
    store.setScrollOffset(selectMainScrollKey(store.getState()), 7);
    store.pushRoute({
        ctxId: "ctx-a",
        page: "audit",
        scope: "context",
        view: "context",
    });
    store.setMainFocusId("audit-call:call-2");
    store.setScrollOffset(selectMainScrollKey(store.getState()), 11);

    store.setSelectedPage("logs");
    store.patchControlReadModel({ instanceState: { ["alpha"]: { logs: [
        {
            at: "2026-07-31T00:00:01.000Z",
            ctxId: "ctx-a",
            instanceName: "alpha",
            message: "done",
            seq: 18,
            stream: "stdout",
        },
    ] } } });
    store.pushRoute({
        ctxId: "ctx-a",
        page: "logs",
        scope: "context",
        view: "context",
    });
    store.setMainFocusId("log-entry:18");

    store.setSelectedPage("audit");
    assert.deepEqual(currentTuiRoute(store.getState()), {
        ctxId: "ctx-a",
        page: "audit",
        scope: "context",
        view: "context",
    });
    assert.equal(store.getState().ui.mainFocusId, "audit-call:call-2");
    assert.equal(
        store.getState().ui.scrollOffsets[
            selectMainScrollKey(store.getState())
        ],
        11,
    );

    assert.equal(store.popRoute(), true);
    assert.deepEqual(currentTuiRoute(store.getState()), {
        page: "audit",
        view: "contexts",
    });
    assert.equal(store.getState().ui.mainFocusId, "audit-context:ctx-a");
    assert.equal(
        store.getState().ui.scrollOffsets[
            selectMainScrollKey(store.getState())
        ],
        7,
    );

    store.setSelectedInstance("beta");
    assert.deepEqual(currentTuiRoute(store.getState()), {
        page: "audit",
        view: "contexts",
    });
    assert.equal(store.getState().ui.mainFocusId, undefined);

    store.setSelectedInstance("alpha");
    assert.deepEqual(currentTuiRoute(store.getState()), {
        page: "audit",
        view: "contexts",
    });
    assert.equal(store.getState().ui.mainFocusId, "audit-context:ctx-a");
});

test("resource refresh removes invalid trailing routes instead of retaining a blank detail page", () => {
    const store = createStore();
    store.setSelectedPage("audit");
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
    store.pushRoute({
        ctxId: "ctx-a",
        page: "audit",
        scope: "context",
        view: "context",
    });

    store.patchControlReadModel({ instanceState: { ["alpha"]: { toolCalls: [] } } });

    assert.deepEqual(currentTuiRoute(store.getState()), {
        page: "audit",
        view: "contexts",
    });
});

test("footer breadcrumb follows the route stack and excludes overlay state", () => {
    const store = createStore();
    store.setSelectedPage("audit");
    store.patchControlReadModel({ instanceState: { ["alpha"]: { toolCalls: [
        {
            callId: "bash_run",
            inputSummary: "{}",
            instance: "alpha" as never,
            source: "mcp",
            startedAt: "2026-07-31T00:00:00.000Z",
            status: "completed",
            toolName: "bash_run",
        },
    ] } } });
    store.pushRoute({
        page: "audit",
        scope: "unscoped",
        view: "context",
    });
    store.pushRoute({
        callId: "bash_run",
        page: "audit",
        scope: "unscoped",
        view: "call",
    });
    store.pushOverlay({
        body: "Confirm action",
        cancelLabel: "Cancel",
        confirmIntent: { type: "ui.cancel" },
        confirmLabel: "Confirm",
        kind: "confirmation",
        selectedAction: "cancel",
        title: "Confirm",
    });

    assert.deepEqual(selectBreadcrumbSegments(store.getState()), [
        "audit",
        "unscoped",
        "bash_run",
    ]);
});

test("Audit footer exposes Comment only on concrete Context routes", () => {
    const store = createStore();
    store.setSelectedPage("audit");
    store.setFocusScope("mainBoxes");

    assert.equal(selectFooterShortcuts(store.getState()).includes("m comment"), false);

    store.pushRoute({
        ctxId: "ctx-a",
        page: "audit",
        scope: "context",
        view: "context",
    });
    assert.equal(selectFooterShortcuts(store.getState()).includes("m comment"), true);

    store.setFocusScope("boxDetail");
    assert.equal(selectFooterShortcuts(store.getState()).includes("m comment"), true);
});

test("Audit Comment footer reflects browse and edit modes", () => {
    const store = createStore();
    store.setSelectedPage("audit");
    store.pushRoute({
        ctxId: "ctx-a",
        page: "audit",
        scope: "context",
        view: "conversation",
    });
    store.setFocusScope("mainBoxes");

    assert.deepEqual(selectFooterShortcuts(store.getState()), [
        "space expand",
        "↑↓ draft",
        "enter edit",
        "esc back",
    ]);

    store.setFocusScope("contextConversation");
    assert.deepEqual(selectFooterShortcuts(store.getState()), [
        "type",
        "enter send",
        "pgup/pgdn",
        "esc",
    ]);
});

test("Todo detail breadcrumb uses the task title instead of the selected instance", () => {
    const store = createStore();
    store.patchControlReadModel({ instanceState: { ["alpha"]: { todo: {
        items: [],
        revision: 1,
        summary: { completed: 0, total: 0 },
        tasks: [
            {
                completed: 0,
                revision: 1,
                status: "pending",
                taskId: "task-1",
                title: "Implement router",
                total: 3,
                updatedAt: "2026-07-31T00:00:00.000Z",
            },
        ],
    } } } });
    store.setSelectedPage("todo");
    store.pushRoute({ page: "todo", todoId: "task-1", view: "detail" });

    assert.deepEqual(selectBreadcrumbSegments(store.getState()), [
        "todo",
        "Implement router",
    ]);
});

test("Logs groups one instance by context and Enter opens only the focused context", () => {
    const store = createStore();
    store.patchControlReadModel({ instanceState: { ["alpha"]: { logs: [
        {
            at: "2026-07-31T00:00:01.000Z",
            ctxId: "ctx-a",
            instanceName: "alpha",
            message: "ctx-a message",
            seq: 1,
            stream: "stdout",
        },
        {
            at: "2026-07-31T00:00:02.000Z",
            ctxId: "ctx-b",
            instanceName: "alpha",
            message: "ctx-b message",
            seq: 2,
            stream: "stderr",
        },
        {
            at: "2026-07-31T00:00:03.000Z",
            instanceName: "alpha",
            message: "control message",
            seq: 3,
            stream: "stdout",
        },
        {
            at: "2026-07-31T00:00:04.000Z",
            ctxId: "unscoped",
            instanceName: "alpha",
            message: "real unscoped context",
            seq: 4,
            stream: "stdout",
        },
    ] } } });
    store.setSelectedPage("logs");

    assert.deepEqual(
        selectMainScreenModel(store.getState()).boxes.map((box) => box.id),
        [
            "log-context:unscoped",
            "log-context:unscoped",
            "log-context:ctx-b",
            "log-context:ctx-a",
        ],
    );

    store.setMainFocusId("log-context:ctx-a");
    const navigation = new TuiCommandDispatcherNavigation({
        focus: { syncMainFocus() {} } as unknown as TuiCommandDispatcherFocus,
        focusManager: {} as unknown as TuiFocusManager,
        async onLogsReload() {},
        async onPageReload() {},
        onRedraw() {},
        projection: tuiViewProjection,
        store,
    });

    assert.equal(navigation.openFocusedRoute(), true);
    assert.deepEqual(currentTuiRoute(store.getState()), {
        ctxId: "ctx-a",
        page: "logs",
        scope: "context",
        view: "context",
    });
    const collapsedDetail = selectMainScreenModel(store.getState()).boxes.find(
        (box) => box.id === "logs",
    );
    assert.ok(collapsedDetail !== undefined);
    store.toggleExpanded(collapsedDetail.expandedKey);
    const detail = selectMainScreenModel(store.getState()).boxes.find(
        (box) => box.id === "logs",
    );
    assert.equal(
        detail?.expandedLines.some((line) =>
            line.text.includes("ctx-a message"),
        ),
        true,
    );
    assert.equal(
        detail?.expandedLines.some((line) =>
            line.text.includes("ctx-b message"),
        ),
        false,
    );
});

test("page changes made from the sidebar preserve sidebar focus until the user enters the page", () => {
    const store = createStore();
    store.setFocusScope("sidebarPages");

    store.setSelectedPage("terminal");

    assert.equal(store.getState().interaction.focusScope, "sidebarPages");
});
