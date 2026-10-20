import { createElement } from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { WriteStream } from "node:tty";
import { render } from "ink";
import { buildFocusGraphForState, selectMainScreenModel, TuiAppStore, TuiCommandDispatcher, TuiFocusManager } from "../../src/testing.ts";
import type { TuiCommandDispatcherOptions } from "../../src/interaction/command/Dispatch.ts";
import type { TuiUiIntent } from "../../src/state/Interaction.ts";
import { TuiOverlayView } from "../../src/view/overlay/View.tsx";
import { TuiTestDomains } from "./DomainHarness.ts";

export function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
export function round4Tui(overrides: Partial<TuiCommandDispatcherOptions> = {}) {
    const domains = new TuiTestDomains(); const store = new TuiAppStore();
    domains.setInstances([{ name: "alpha", enabled: true, mcpEnabled: true }, { name: "beta", enabled: true, mcpEnabled: true }]);
    store.setSelectedPage("instances"); store.setSelectedInstance("alpha");
    const model = () => selectMainScreenModel(store.getState(), domains.reader);
    const focusManager = new TuiFocusManager(store, {
        boxIdForLine: (id) => model().boxes.find((box) => box.expandedLines.some((line) => line.id === id))?.id,
        currentPage: () => store.getState().ui.selectedPage,
        expandedKeyFor: (id) => model().boxes.find((box) => box.id === id)?.expandedKey,
        graphFor: (page, mode) => buildFocusGraphForState({ ...store.getState(),
            interaction: { ...store.getState().interaction, focusScope: mode },
            ui: { ...store.getState().ui, selectedPage: page } }, domains.reader),
        mode: () => store.getState().interaction.focusScope,
    });
    const dispatcher = new TuiCommandDispatcher({ store, focusManager, projection: domains.projection,
        mainViewportRows: () => 24, onApprovalDecision: async () => undefined,
        onInstanceAction: async () => undefined, onOpenTerminal: async () => undefined,
        onPageReload: async () => undefined, onQuit: async () => undefined,
        onRedraw: () => undefined, onToolCall: async () => true, ...overrides });
    const top = () => store.getState().interaction.overlays.at(-1);
    const confirm = async (instance = "alpha", confirmIntent: TuiUiIntent = { type: "instance.delete", instance }) => {
        await dispatcher.dispatch({ type: "overlay.openConfirm", title: `Delete ${instance}`,
            body: `Delete ${instance}?`, confirmLabel: "Delete", confirmIntent });
        await dispatcher.dispatch({ type: "confirm.focus", button: "confirm" });
    };
    return { domains, store, dispatcher, top, confirm, model };
}
export async function renderRound4Overlay(harness: ReturnType<typeof round4Tui>) {
    const output = new PassThrough(); let captured = "";
    output.on("data", (chunk) => { captured += chunk.toString(); });
    const view = render(createElement(TuiOverlayView, { reader: harness.domains.reader,
        state: harness.store.getState(), viewportRows: 24, width: 100 }),
        { debug: true, patchConsole: false, exitOnCtrlC: false, stdout: output as unknown as WriteStream });
    try { await new Promise<void>((resolve) => setImmediate(resolve)); }
    finally { view.cleanup(); output.destroy(); }
    return stripVTControlCharacters(captured);
}

export async function renderRound4Screen(harness: ReturnType<typeof round4Tui>) {
    const { TuiScreenRouter } = await import("../../src/view/shell/Router.tsx");
    const output = new PassThrough(); let captured = "";
    output.on("data", (chunk) => { captured += chunk.toString(); });
    const view = render(createElement(TuiScreenRouter, { reader: harness.domains.reader,
        state: harness.store.getState(), viewportRows: 60, boxInnerWidth: 96, contentWidth: 100 }),
        { debug: true, patchConsole: false, exitOnCtrlC: false, stdout: output as unknown as WriteStream });
    try { await new Promise<void>((resolve) => setImmediate(resolve)); }
    finally { view.cleanup(); output.destroy(); }
    return stripVTControlCharacters(captured);
}
