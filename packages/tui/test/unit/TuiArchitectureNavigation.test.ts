import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import {
    buildFocusGraphForState,
    currentTuiRoute,
    selectMainScreenModel,
    topTuiOverlay,
    tuiViewProjection,
    TuiAppStore,
    TuiCommandDispatcherFocus,
    TuiCommandDispatcherNavigation,
    TuiFocusManager,
} from "../../src/testing.ts";

function createHarness() {
    const store = new TuiAppStore();
    store.patchControlReadModel({ instances: [
        {
            homeDirectory: "/workspace/alpha",
            enabled: true,
            mcpEnabled: false,
            name: "alpha",
            provider: "local",
        },
        {
            homeDirectory: "/workspace/beta",
            enabled: true,
            mcpEnabled: true,
            name: "beta",
            provider: "ssh",
        },
    ] });
    store.patchControlSnapshot({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 1,
        name: asInstanceName("alpha"),
        ready: true,
        status: "ready",
    });
    const focusManager = new TuiFocusManager(store, {
        boxIdForLine: (lineId) =>
            selectMainScreenModel(store.getState()).boxes.find((box) =>
                box.expandedLines.some((line) => line.id === lineId),
            )?.id,
        currentPage: () => store.getState().ui.selectedPage,
        expandedKeyFor: (boxId) =>
            selectMainScreenModel(store.getState()).boxes.find(
                (box) => box.id === boxId,
            )?.expandedKey,
        graphFor: (page, mode) =>
            buildFocusGraphForState({
                ...store.getState(),
                interaction: {
                    ...store.getState().interaction,
                    focusScope: mode,
                },
                ui: {
                    ...store.getState().ui,
                    selectedPage: page,
                },
            }),
        mode: () => store.getState().interaction.focusScope,
    });
    const focus = new TuiCommandDispatcherFocus({
        mainViewportRows: () => 30,
        projection: tuiViewProjection,
        store,
    });
    const reloads: Array<{ instance?: string; page: string }> = [];
    let redraws = 0;
    const navigation = new TuiCommandDispatcherNavigation({
        focus,
        focusManager,
        onLogsReload: async () => {
            reloads.push({
                instance: store.getState().ui.selectedInstance,
                page: "logs-buffer",
            });
        },
        onPageReload: async (page, instance) => {
            reloads.push({ instance, page });
        },
        onRedraw: () => {
            redraws += 1;
        },
        projection: tuiViewProjection,
        store,
    });
    focusManager.syncPanel(
        store.getState().ui.selectedPage,
        store.getState().interaction.focusScope,
    );
    return {
        focus,
        focusManager,
        navigation,
        redraws: () => redraws,
        reloads,
        store,
    };
}

test("navigation controller owns page selection and the two-stage sidebar/main cycle", async () => {
    const harness = createHarness();

    assert.equal(
        harness.store.getState().interaction.focusScope,
        "sidebarContext",
    );
    assert.equal(
        await harness.navigation.dispatch({
            direction: "next",
            type: "focus.move",
        }),
        true,
    );
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(harness.store.getState().ui.mainFocusId, "create-instance");

    assert.equal(
        await harness.navigation.dispatch({
            direction: "previous",
            type: "focus.move",
        }),
        true,
    );
    assert.equal(
        harness.store.getState().interaction.focusScope,
        "sidebarContext",
    );

    assert.equal(
        await harness.navigation.dispatch({
            page: "config",
            type: "page.select",
        }),
        true,
    );
    assert.equal(harness.store.getState().ui.selectedPage, "config");
    assert.deepEqual(harness.store.getState().interaction.sidebarCursor, {
        id: "config",
        kind: "context",
    });

    assert.equal(
        await harness.navigation.dispatch({
            page: "audit",
            type: "page.select",
        }),
        true,
    );
    assert.deepEqual(harness.reloads, []);

    assert.equal(
        await harness.navigation.dispatch({
            index: 1,
            type: "instance.selectIndex",
        }),
        true,
    );
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
    assert.deepEqual(harness.store.getState().interaction.sidebarCursor, {
        id: "beta",
        kind: "instance",
    });
});

test("sidebar wheel moves viewport focus without activating the Context or Instance", async () => {
    const harness = createHarness();
    harness.store.setSelectedPage("instances");
    harness.store.setSidebarCursor({ id: "instances", kind: "context" });
    harness.store.setFocusScope("sidebarContext");

    assert.equal(
        await harness.navigation.dispatch({
            delta: 1,
            section: "context",
            type: "sidebar.scroll",
        }),
        true,
    );
    assert.equal(harness.store.getState().ui.selectedPage, "instances");
    assert.deepEqual(harness.store.getState().interaction.sidebarCursor, {
        id: "config",
        kind: "context",
    });

    harness.store.setSelectedInstance("alpha");
    harness.store.setSidebarCursor({ id: "alpha", kind: "instance" });
    harness.store.setFocusScope("sidebarInstances");
    assert.equal(
        await harness.navigation.dispatch({
            delta: 1,
            section: "instances",
            type: "sidebar.scroll",
        }),
        true,
    );
    assert.equal(harness.store.getState().ui.selectedInstance, "alpha");
    assert.deepEqual(harness.store.getState().interaction.sidebarCursor, {
        id: "beta",
        kind: "instance",
    });
});

test("navigation controller preserves and restores focus around search and confirm overlays", async () => {
    const harness = createHarness();
    await harness.navigation.dispatch({ page: "logs", type: "page.select" });

    assert.equal(
        await harness.navigation.dispatch({ type: "search.open" }),
        true,
    );
    assert.equal(harness.store.getState().interaction.focusScope, "search");
    await harness.navigation.dispatch({ text: "error", type: "search.append" });
    assert.equal(harness.store.getState().ui.searchQueries.logs, "error");
    assert.equal(
        await harness.navigation.dispatch({ type: "search.submit" }),
        true,
    );
    assert.equal(
        harness.store.getState().interaction.focusScope,
        "sidebarContext",
    );

    assert.equal(
        await harness.navigation.dispatch({
            body: "Delete alpha?",
            confirmIntent: { instance: "alpha", type: "instance.delete" },
            title: "Confirm",
            type: "overlay.openConfirm",
        }),
        true,
    );
    assert.equal(harness.store.getState().interaction.focusScope, "confirm");
    let overlay = topTuiOverlay(harness.store.getState().interaction.overlays);
    assert.equal(overlay?.kind, "confirmation");
    await harness.navigation.dispatch({
        button: "confirm",
        type: "confirm.focus",
    });
    overlay = topTuiOverlay(harness.store.getState().interaction.overlays);
    assert.equal(
        overlay?.kind === "confirmation" ? overlay.selectedAction : undefined,
        "confirm",
    );
    assert.equal(
        await harness.navigation.dispatch({ type: "confirm.cancel" }),
        true,
    );
    assert.equal(
        topTuiOverlay(harness.store.getState().interaction.overlays),
        undefined,
    );
    assert.equal(
        harness.store.getState().interaction.focusScope,
        "sidebarContext",
    );
});

test("contextual help opens as an overlay and restores the exact page context", async () => {
    const harness = createHarness();
    await harness.navigation.dispatch({ page: "audit", type: "page.select" });
    harness.store.setSidebarCursor({ id: "audit:back", kind: "context" });
    const routeBefore = currentTuiRoute(harness.store.getState());
    const cursorBefore = harness.store.getState().interaction.sidebarCursor;

    assert.equal(await harness.navigation.dispatch({ type: "ui.help" }), true);
    assert.equal(harness.store.getState().ui.selectedPage, "audit");
    assert.deepEqual(currentTuiRoute(harness.store.getState()), routeBefore);
    const overlay = topTuiOverlay(harness.store.getState().interaction.overlays);
    assert.equal(overlay?.kind, "text-detail");
    assert.match(overlay?.kind === "text-detail" ? overlay.body : "", /Page: audit/u);
    assert.equal(harness.store.getState().interaction.focusScope, "textDetail");

    assert.equal(await harness.navigation.dispatch({ type: "textDetail.close" }), true);
    assert.equal(harness.store.getState().ui.selectedPage, "audit");
    assert.deepEqual(currentTuiRoute(harness.store.getState()), routeBefore);
    assert.deepEqual(harness.store.getState().interaction.sidebarCursor, cursorBefore);
    assert.equal(harness.store.getState().interaction.focusScope, "sidebarContext");
});

test("Messages scope row switches between Active and History without leaving the feature", async () => {
    const harness = createHarness();
    await harness.navigation.dispatch({ page: "messages", type: "page.select" });
    harness.store.setSidebarCursor({ id: "messages:scope", kind: "context" });

    assert.equal(await harness.navigation.activateSidebarSelection(), true);
    assert.equal(harness.store.getState().ui.messageScope, "history");
    assert.deepEqual(currentTuiRoute(harness.store.getState()), {
        page: "messages",
        view: "contexts",
    });

    harness.store.setSidebarCursor({ id: "messages:scope", kind: "context" });
    assert.equal(await harness.navigation.activateSidebarSelection(), true);
    assert.equal(harness.store.getState().ui.messageScope, "active");
});

test("navigation controller owns box expansion, scrolling, logs follow, reload, and redraw", async () => {
    const harness = createHarness();
    await harness.navigation.dispatch({
        direction: "next",
        type: "focus.move",
    });
    harness.store.setMainFocusId("instance:alpha");

    assert.equal(
        await harness.navigation.dispatch({ type: "screen.toggle" }),
        true,
    );
    assert.equal(
        harness.store.getState().ui.expandedBoxes["instances:alpha:instance"],
        true,
    );
    assert.equal(
        await harness.navigation.dispatch({ type: "screen.pageDown" }),
        true,
    );
    assert.equal(
        await harness.navigation.dispatch({ type: "screen.home" }),
        true,
    );

    await harness.navigation.dispatch({ page: "logs", type: "page.select" });
    assert.deepEqual(harness.reloads, []);
    assert.equal(
        await harness.navigation.dispatch({ type: "logs.toggleFollow" }),
        true,
    );
    assert.equal(harness.store.getState().ui.logsFollowByInstance.alpha, false);
    assert.equal(
        await harness.navigation.dispatch({ type: "logs.clearBuffer" }),
        true,
    );

    assert.equal(
        await harness.navigation.dispatch({ type: "page.reload" }),
        true,
    );
    assert.deepEqual(harness.reloads.at(-1), {
        instance: "alpha",
        page: "logs-buffer",
    });
    assert.equal(
        await harness.navigation.dispatch({ type: "ui.redraw" }),
        true,
    );
    assert.equal(harness.redraws(), 1);
});
