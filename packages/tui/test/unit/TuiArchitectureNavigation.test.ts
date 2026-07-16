import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { buildFocusGraphForState, TuiAppStore, TuiCommandDispatcherFocus, TuiCommandDispatcherNavigation, TuiFocusManager } from "../../dist/testing.js";

function createHarness() {
    const store = new TuiAppStore();
    store.replaceInstances([
        {
            defaultWorkspace: "/workspace/alpha",
            enabled: true,
            mcpEnabled: false,
            name: "alpha",
            provider: "local"
        },
        {
            defaultWorkspace: "/workspace/beta",
            enabled: true,
            mcpEnabled: true,
            name: "beta",
            provider: "ssh"
        }
    ]);
    store.replaceSnapshot({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 1,
        name: asInstanceName("alpha"),
        ready: true,
        status: "ready"
    });
    const focusManager = new TuiFocusManager(store, {
        currentPage: () => store.getState().ui.selectedPage,
        graphFor: (page, mode) => buildFocusGraphForState({
            ...store.getState(),
            interaction: {
                ...store.getState().interaction,
                focusScope: mode
            },
            ui: {
                ...store.getState().ui,
                selectedPage: page
            }
        }),
        mode: () => store.getState().interaction.focusScope
    });
    const focus = new TuiCommandDispatcherFocus({
        mainViewportRows: () => 30,
        store
    });
    const reloads: Array<{ instance?: string; page: string }> = [];
    let redraws = 0;
    const navigation = new TuiCommandDispatcherNavigation({
        focus,
        focusManager,
        onLogsReload: async () => {
            reloads.push({
                instance: store.getState().ui.selectedInstance,
                page: "logs-buffer"
            });
        },
        onPageReload: async (page, instance) => {
            reloads.push({ instance, page });
        },
        onRedraw: () => {
            redraws += 1;
        },
        store
    });
    focusManager.syncPanel(
        store.getState().ui.selectedPage,
        store.getState().interaction.focusScope
    );
    return {
        focus,
        focusManager,
        navigation,
        redraws: () => redraws,
        reloads,
        store
    };
}

test("navigation controller owns page selection and the two-stage sidebar/main cycle", async () => {
    const harness = createHarness();

    assert.equal(harness.store.getState().interaction.focusScope, "sidebarPages");
    assert.equal(await harness.navigation.dispatch({
        direction: "next",
        type: "focus.move"
    }), true);
    assert.equal(harness.store.getState().interaction.focusScope, "mainBoxes");
    assert.equal(harness.store.getState().ui.mainFocusId, "create-instance");

    assert.equal(await harness.navigation.dispatch({
        direction: "previous",
        type: "focus.move"
    }), true);
    assert.equal(harness.store.getState().interaction.focusScope, "sidebarPages");

    assert.equal(await harness.navigation.dispatch({
        page: "config",
        type: "page.select"
    }), true);
    assert.equal(harness.store.getState().ui.selectedPage, "config");
    assert.deepEqual(harness.store.getState().interaction.sidebarCursor, {
        id: "config",
        kind: "page"
    });

    assert.equal(await harness.navigation.dispatch({
        index: 1,
        type: "instance.selectIndex"
    }), true);
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
    assert.deepEqual(harness.store.getState().interaction.sidebarCursor, {
        id: "beta",
        kind: "instance"
    });
});

test("navigation controller preserves and restores focus around search and confirm overlays", async () => {
    const harness = createHarness();
    await harness.navigation.dispatch({ page: "logs", type: "page.select" });

    assert.equal(await harness.navigation.dispatch({ type: "search.open" }), true);
    assert.equal(harness.store.getState().interaction.focusScope, "search");
    await harness.navigation.dispatch({ text: "error", type: "search.append" });
    assert.equal(harness.store.getState().ui.searchQueries.logs, "error");
    assert.equal(await harness.navigation.dispatch({ type: "search.submit" }), true);
    assert.equal(harness.store.getState().interaction.focusScope, "sidebarPages");

    assert.equal(await harness.navigation.dispatch({
        body: "Delete alpha?",
        confirmIntent: { instance: "alpha", type: "instance.delete" },
        title: "Confirm",
        type: "overlay.openConfirm"
    }), true);
    assert.equal(harness.store.getState().interaction.focusScope, "confirm");
    assert.equal(harness.store.getState().interaction.confirmDialog.open, true);
    await harness.navigation.dispatch({ button: "confirm", type: "confirm.focus" });
    assert.equal(harness.store.getState().interaction.selectedConfirmButton, "confirm");
    assert.equal(await harness.navigation.dispatch({ type: "confirm.cancel" }), true);
    assert.equal(harness.store.getState().interaction.confirmDialog.open, false);
    assert.equal(harness.store.getState().interaction.focusScope, "sidebarPages");
});

test("navigation controller owns box expansion, scrolling, logs follow, reload, and redraw", async () => {
    const harness = createHarness();
    await harness.navigation.dispatch({ direction: "next", type: "focus.move" });
    harness.store.setMainFocusId("instance:alpha");

    assert.equal(await harness.navigation.dispatch({ type: "screen.toggle" }), true);
    assert.equal(
        harness.store.getState().ui.expandedBoxes["instances:alpha:instance"],
        true
    );
    assert.equal(await harness.navigation.dispatch({ type: "screen.pageDown" }), true);
    assert.equal(await harness.navigation.dispatch({ type: "screen.home" }), true);

    await harness.navigation.dispatch({ page: "logs", type: "page.select" });
    assert.equal(harness.reloads.at(-1)?.page, "logs-buffer");
    assert.equal(await harness.navigation.dispatch({ type: "logs.toggleFollow" }), true);
    assert.equal(harness.store.getState().ui.logsFollowByInstance.alpha, false);
    assert.equal(await harness.navigation.dispatch({ type: "logs.clearBuffer" }), true);

    assert.equal(await harness.navigation.dispatch({ type: "page.reload" }), true);
    assert.deepEqual(harness.reloads.at(-1), {
        instance: "alpha",
        page: "logs"
    });
    assert.equal(await harness.navigation.dispatch({ type: "ui.redraw" }), true);
    assert.equal(harness.redraws(), 1);
});
