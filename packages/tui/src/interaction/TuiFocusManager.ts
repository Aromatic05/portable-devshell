import type { TuiAppStore } from "../store/TuiAppStore.js";
import { FocusGraph, type FocusDirection } from "./FocusGraph.js";
import { type FocusItem, type TuiMode, isSameFocusItem } from "./TuiInteractionTypes.js";
import type { PageId } from "../model/TuiUiTypes.js";

export interface FocusManagerContext {
    currentPage(): PageId;
    graphFor(page: PageId, mode: TuiMode): FocusGraph;
    mode(): TuiMode;
}

export class TuiFocusManager {
    readonly #context: FocusManagerContext;
    readonly #pageMemory = new Map<PageId, FocusItem>();
    readonly #restoreStack: Array<{ focus?: FocusItem; mode: TuiMode; page: PageId }> = [];
    readonly #store: TuiAppStore;

    constructor(store: TuiAppStore, context: FocusManagerContext) {
        this.#store = store;
        this.#context = context;
    }

    currentFocus(): FocusItem | undefined {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "sidebarPages") {
            const cursor = this.#store.getState().interaction.sidebarCursor;
            if (cursor?.kind === "page") {
                return cursor;
            }
            return { id: this.#store.getState().ui.selectedPage, kind: "page" };
        }
        if (scope === "sidebarInstances") {
            const cursor = this.#store.getState().interaction.sidebarCursor;
            if (cursor?.kind === "instance") {
                return cursor;
            }
            const instance = this.#store.getState().ui.selectedInstance;
            return instance === undefined ? undefined : { id: instance, kind: "instance" };
        }
        if (scope === "mainBoxes" || scope === "boxDetail") {
            const boxId = this.#store.getState().ui.mainFocusId;
            return boxId === undefined ? undefined : { id: boxId, kind: "box" };
        }
        if (scope === "actionMenu") {
            const actionId = this.#store.getState().interaction.selectedActionId;
            return actionId === undefined ? undefined : { id: actionId, kind: "action" };
        }
        if (scope === "confirm") {
            return { id: this.#store.getState().interaction.selectedConfirmButton, kind: "button" };
        }
        if (scope === "search") {
            return { id: "search.query", kind: "field" };
        }
        if (scope === "toolForm") {
            return { id: "toolForm.input", kind: "field" };
        }
        return undefined;
    }

    currentMode(): TuiMode {
        return this.#store.getState().interaction.focusScope;
    }

    currentPage(): PageId {
        return this.#store.getState().ui.selectedPage;
    }

    syncPanel(page: PageId, mode = this.currentMode()): void {
        const graph = this.#context.graphFor(page, mode);
        const remembered = this.#pageMemory.get(page);
        const current = this.currentFocus();
        const nextFocus = graph.includes(current) ? current : graph.includes(remembered) ? remembered : graph.first();
        this.#applyFocus(nextFocus);

        if (nextFocus !== undefined) {
            this.#pageMemory.set(page, nextFocus);
        }
    }

    move(direction: FocusDirection): boolean {
        const page = this.currentPage();
        const graph = this.#context.graphFor(page, this.currentMode());
        const next = graph.move(this.currentFocus(), direction);

        if (next === undefined || isSameFocusItem(next, this.currentFocus())) {
            return false;
        }

        this.#applyFocus(next);
        this.#pageMemory.set(page, next);
        return true;
    }

    setFocus(item: FocusItem): boolean {
        const page = this.currentPage();
        const graph = this.#context.graphFor(page, this.currentMode());

        if (!graph.includes(item)) {
            return false;
        }

        this.#applyFocus(item);
        this.#pageMemory.set(page, item);
        return true;
    }

    pushRestore(mode: TuiMode): void {
        this.#restoreStack.push({
            focus: this.currentFocus(),
            mode: this.currentMode(),
            page: this.currentPage()
        });
        this.#store.setFocusScope(mode);
    }

    restore(): boolean {
        const restored = this.#restoreStack.pop();

        if (restored === undefined) {
            return false;
        }

        this.#store.setFocusScope(restored.mode);
        this.#store.setSelectedPage(restored.page);
        this.syncPanel(restored.page, restored.mode);

        if (restored.focus !== undefined) {
            this.setFocus(restored.focus);
        }

        return true;
    }

    #applyFocus(item: FocusItem | undefined): void {
        if (item === undefined) {
            return;
        }

        switch (item.kind) {
            case "page":
                this.#store.setFocusScope("sidebarPages");
                this.#store.setSidebarFocus("pages");
                this.#store.setSidebarCursor(item);
                return;
            case "instance":
                this.#store.setFocusScope("sidebarInstances");
                this.#store.setSidebarFocus("instances");
                this.#store.setSidebarCursor(item);
                return;
            case "box":
                this.#store.setFocusScope("mainBoxes");
                this.#store.setMainFocusId(item.id);
                return;
            case "action":
                this.#store.setFocusScope("actionMenu");
                return;
            case "button":
                this.#store.setFocusScope("confirm");
                this.#store.setConfirmFocus(item.id === "confirm" ? "confirm" : "cancel");
                return;
            case "field":
                this.#store.setFocusScope(this.currentMode() === "toolForm" ? "toolForm" : "search");
                return;
        }
    }
}
