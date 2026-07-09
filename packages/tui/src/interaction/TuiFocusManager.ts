import type { TuiAppStore } from "../store/TuiAppStore.js";
import type { TuiPanel } from "../store/TuiReducers.js";
import { FocusGraph, type FocusDirection } from "./FocusGraph.js";
import { type FocusItem, type TuiMode, isSameFocusItem } from "./TuiInteractionTypes.js";

export interface FocusManagerContext {
    currentPanel(): TuiPanel;
    graphFor(panel: TuiPanel, mode: TuiMode): FocusGraph;
    mode(): TuiMode;
}

export class TuiFocusManager {
    readonly #context: FocusManagerContext;
    readonly #panelMemory = new Map<TuiPanel, FocusItem>();
    readonly #restoreStack: Array<{ focus?: FocusItem; mode: TuiMode; panel: TuiPanel }> = [];
    readonly #store: TuiAppStore;

    constructor(store: TuiAppStore, context: FocusManagerContext) {
        this.#store = store;
        this.#context = context;
    }

    currentFocus(): FocusItem | undefined {
        return this.#store.getState().interaction.currentFocus;
    }

    currentMode(): TuiMode {
        return this.#store.getState().interaction.mode;
    }

    currentPanel(): TuiPanel {
        return this.#store.getState().activePanel;
    }

    syncPanel(panel: TuiPanel, mode = this.currentMode()): void {
        const graph = this.#context.graphFor(panel, mode);
        const remembered = this.#panelMemory.get(panel);
        const current = this.currentFocus();
        const nextFocus = graph.includes(current) ? current : graph.includes(remembered) ? remembered : graph.first();
        this.#store.setCurrentFocus(nextFocus);

        if (nextFocus !== undefined) {
            this.#panelMemory.set(panel, nextFocus);
        }
    }

    move(direction: FocusDirection): boolean {
        const panel = this.currentPanel();
        const graph = this.#context.graphFor(panel, this.currentMode());
        const next = graph.move(this.currentFocus(), direction);

        if (next === undefined || isSameFocusItem(next, this.currentFocus())) {
            return false;
        }

        this.#store.setCurrentFocus(next);
        this.#panelMemory.set(panel, next);
        return true;
    }

    setFocus(item: FocusItem): boolean {
        const panel = this.currentPanel();
        const graph = this.#context.graphFor(panel, this.currentMode());

        if (!graph.includes(item)) {
            return false;
        }

        this.#store.setCurrentFocus(item);
        this.#panelMemory.set(panel, item);
        return true;
    }

    pushRestore(mode: TuiMode): void {
        this.#restoreStack.push({
            focus: this.currentFocus(),
            mode: this.currentMode(),
            panel: this.currentPanel()
        });
        this.#store.setMode(mode);
    }

    restore(): boolean {
        const restored = this.#restoreStack.pop();

        if (restored === undefined) {
            return false;
        }

        this.#store.setMode(restored.mode);
        this.#store.setActivePanel(restored.panel);
        this.syncPanel(restored.panel, restored.mode);

        if (restored.focus !== undefined) {
            this.setFocus(restored.focus);
        }

        return true;
    }
}
