import assert from "node:assert/strict";
import test from "node:test";

import React, { isValidElement } from "react";

import {
    buildFocusGraphForState,
    CommandDispatcher,
    KeyDispatcher,
    ScreenRouter,
    selectFooterText,
    TuiAppStore,
    TuiFocusManager
} from "../../dist/index.js";

test("Prompt 2 panel routing and focus graph navigation stay inside the current panel", async () => {
    const harness = createHarness();

    await harness.press("2");
    assert.equal(harness.store.getState().activePanel, "config");
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "config.summary", kind: "card" });

    await harness.press("", { tab: true });
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "config.localToggle", kind: "field" });

    await harness.press("", { downArrow: true });
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "save", kind: "button" });

    await harness.press("", { rightArrow: true });
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "cancel", kind: "button" });

    await harness.press("", { leftArrow: true });
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "save", kind: "button" });

    await harness.press("]");
    assert.equal(harness.store.getState().activePanel, "connector");
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "connector.summary", kind: "card" });

    await harness.press("[");
    assert.equal(harness.store.getState().activePanel, "config");
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "save", kind: "button" });

    await harness.press("", { end: true });
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "cancel", kind: "button" });

    await harness.press("", { home: true });
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "config.summary", kind: "card" });

    await harness.press("", { pageDown: true });
    assert.equal(harness.store.getState().interaction.screenStatusByPanel.config, "pageDown handled by config panel.");
});

test("Prompt 2 action menu opens, moves, executes, closes, and footer only shows valid shortcuts", async () => {
    const harness = createHarness();

    assert.match(selectFooterText(harness.store.getState()), /1-6/u);

    await harness.press("a");
    assert.equal(harness.store.getState().interaction.mode, "actionMenu");
    assert.equal(harness.store.getState().interaction.actionMenu.open, true);
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "instances.mark", kind: "action" });
    assert.match(selectFooterText(harness.store.getState()), /↑↓ enter/u);
    assert.doesNotMatch(selectFooterText(harness.store.getState()), /1-6/u);

    await harness.press("", { downArrow: true });
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "instances.help", kind: "action" });

    await harness.press("[", { ctrl: true });
    assert.equal(harness.store.getState().interaction.mode, "normal");
    assert.equal(harness.store.getState().interaction.actionMenu.open, false);

    await harness.press("a");
    await harness.press("", { downArrow: true });
    await harness.press("", { return: true });
    assert.equal(harness.store.getState().activePanel, "help");
    assert.equal(harness.store.getState().interaction.mode, "normal");
    assert.equal(harness.store.getState().interaction.actionMenu.open, false);
});

test("Prompt 2 search mode handles local input and ctrl+[ closes temporary state without quitting", async () => {
    const harness = createHarness();

    await harness.press("/");
    assert.equal(harness.store.getState().interaction.mode, "search");
    assert.equal(harness.store.getState().interaction.search.open, true);
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "search.query", kind: "field" });
    assert.match(selectFooterText(harness.store.getState()), /type bs enter/u);
    assert.doesNotMatch(selectFooterText(harness.store.getState()), /1-6/u);

    await harness.press("x");
    await harness.press("y");
    assert.equal(harness.store.getState().interaction.search.query, "xy");

    await harness.press("", { backspace: true });
    assert.equal(harness.store.getState().interaction.search.query, "x");

    await harness.press("[", { ctrl: true });
    assert.equal(harness.store.getState().interaction.mode, "normal");
    assert.equal(harness.store.getState().interaction.search.open, false);
    assert.equal(harness.quitCount(), 0);
});

test("Prompt 2 ctrl+d uses confirm dialog when dirty and confirm defaults to cancel", async () => {
    const harness = createHarness();

    await harness.press("2");
    await harness.press("", { tab: true });
    await harness.press(" ");

    assert.equal(harness.store.getState().interaction.mode, "edit");
    assert.equal(harness.store.getState().interaction.dirty, true);
    assert.match(selectFooterText(harness.store.getState()), /\?/u);
    assert.match(selectFooterText(harness.store.getState()), /\bsp\b/u);

    await harness.press("d", { ctrl: true });
    assert.equal(harness.store.getState().interaction.mode, "confirm");
    assert.equal(harness.store.getState().interaction.confirmDialog.open, true);
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "cancel", kind: "button" });
    assert.match(selectFooterText(harness.store.getState()), /tab ←→ enter/u);
    assert.doesNotMatch(selectFooterText(harness.store.getState()), /1-6/u);

    await harness.press("[", { ctrl: true });
    assert.equal(harness.store.getState().interaction.mode, "edit");
    assert.equal(harness.quitCount(), 0);

    await harness.press("d", { ctrl: true });
    await harness.press("", { rightArrow: true });
    assert.deepEqual(harness.store.getState().interaction.currentFocus, { id: "confirm", kind: "button" });
    await harness.press("", { return: true });
    assert.equal(harness.quitCount(), 1);
});

test("Prompt 2 save and cancel are real focus items with visual highlight and enter only activates the focused item", async () => {
    const harness = createHarness();

    await harness.press("2");
    await harness.press("", { tab: true });
    await harness.press(" ");
    await harness.press("", { downArrow: true });

    assert.doesNotMatch(selectFooterText(harness.store.getState()), /\bsp\b/u);
    assert.match(selectFooterText(harness.store.getState()), /\?/u);
    assert.equal(hasHighlightedLabel(harness.store.getState(), "[ Save ]"), true);
    assert.equal(hasHighlightedLabel(harness.store.getState(), "[ Cancel ]"), false);

    await harness.press("", { rightArrow: true });
    assert.equal(hasHighlightedLabel(harness.store.getState(), "[ Save ]"), false);
    assert.equal(hasHighlightedLabel(harness.store.getState(), "[ Cancel ]"), true);

    await harness.press("", { return: true });
    assert.equal(harness.store.getState().interaction.dirty, false);
    assert.equal(harness.store.getState().interaction.screenToggleByPanel.config, false);
    assert.equal(harness.store.getState().interaction.mode, "normal");
});

function createHarness() {
    const store = new TuiAppStore();
    let quitRequests = 0;
    let redrawRequests = 0;
    const focusManager = new TuiFocusManager(store, {
        currentPanel: () => store.getState().activePanel,
        graphFor: (panel, mode) =>
            buildFocusGraphForState({
                ...store.getState(),
                activePanel: panel,
                interaction: {
                    ...store.getState().interaction,
                    mode
                }
            }),
        mode: () => store.getState().interaction.mode
    });
    const commandDispatcher = new CommandDispatcher({
        focusManager,
        onQuit: async () => {
            quitRequests += 1;
        },
        onRedraw: () => {
            redrawRequests += 1;
        },
        store
    });
    const keyDispatcher = new KeyDispatcher();

    focusManager.syncPanel(store.getState().activePanel, store.getState().interaction.mode);

    return {
        async press(input: string, key: Record<string, boolean> = {}) {
            await commandDispatcher.dispatchMany(keyDispatcher.dispatch(store.getState().interaction.mode, { input, key }));
        },
        quitCount() {
            return quitRequests;
        },
        redrawCount() {
            return redrawRequests;
        },
        store
    };
}

function hasHighlightedLabel(state: ReturnType<TuiAppStore["getState"]>, label: string): boolean {
    const tree = renderNode(ScreenRouter({ state }));
    return collectHighlightedText(tree).includes(label);
}

function collectHighlightedText(node: unknown): string[] {
    if (!isValidElement(node)) {
        return [];
    }

    const ownText = node.props.backgroundColor === "cyan" ? [readText(node.props.children)] : [];
    const children = normalizeChildren(node.props.children).flatMap((child) => collectHighlightedText(renderNode(child)));

    return [...ownText, ...children];
}

function renderNode(node: unknown): unknown {
    if (!isValidElement(node)) {
        return node;
    }

    if (typeof node.type === "function" && node.type.name !== "Text" && node.type.name !== "Box") {
        return renderNode(node.type(node.props));
    }

    return node;
}

function normalizeChildren(children: unknown): unknown[] {
    if (Array.isArray(children)) {
        return children;
    }

    return children === undefined || children === null ? [] : [children];
}

function readText(node: unknown): string {
    if (typeof node === "string") {
        return node;
    }

    if (typeof node === "number") {
        return String(node);
    }

    if (Array.isArray(node)) {
        return node.map((child) => readText(child)).join("");
    }

    if (isValidElement(node)) {
        return readText(node.props.children);
    }

    return "";
}
