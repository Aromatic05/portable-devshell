import { buildFocusGraphForState, selectMainScreenModel, TuiAppStore, TuiCommandDispatcher, TuiFocusManager } from "../../src/testing.ts";
import type { TuiCommandDispatcherOptions } from "../../src/interaction/command/Dispatch.ts";
import { TuiTestDomains } from "./DomainHarness.ts";

export function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

export function round6Tui(overrides: Partial<TuiCommandDispatcherOptions> = {}) {
    const domains = new TuiTestDomains();
    const store = new TuiAppStore({ maxRawEvents: 3 });
    domains.setInstances([
        { name: "alpha", enabled: true, mcpEnabled: true },
        { name: "beta", enabled: true, mcpEnabled: true },
    ]);
    store.setSelectedPage("instances");
    store.setSelectedInstance("alpha");
    const model = () => selectMainScreenModel(store.getState(), domains.reader);
    const focusManager = new TuiFocusManager(store, {
        boxIdForLine: (id) => model().boxes.find((box) => box.expandedLines.some((line) => line.id === id))?.id,
        currentPage: () => store.getState().ui.selectedPage,
        expandedKeyFor: (id) => model().boxes.find((box) => box.id === id)?.expandedKey,
        graphFor: (page, mode) => buildFocusGraphForState({
            ...store.getState(),
            interaction: { ...store.getState().interaction, focusScope: mode },
            ui: { ...store.getState().ui, selectedPage: page },
        }, domains.reader),
        mode: () => store.getState().interaction.focusScope,
    });
    const dispatcher = new TuiCommandDispatcher({
        store,
        focusManager,
        projection: domains.projection,
        mainViewportRows: () => 24,
        onApprovalDecision: async () => undefined,
        onInstanceAction: async () => undefined,
        onOpenTerminal: async () => undefined,
        onPageReload: async () => undefined,
        onQuit: async () => undefined,
        onRedraw: () => undefined,
        onToolCall: async () => true,
        ...overrides,
    });
    return { domains, store, dispatcher, model };
}
