import type { TuiAppStore } from "../store/TuiAppStore.js";
import type { TuiAppState } from "../store/TuiReducers.js";
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
        if (scope === "mainBoxes") {
            const state = this.#store.getState();
            const boxId = state.ui.mainFocusId;
            const lineId = boxId === undefined ? undefined : state.interaction.selectedDetailLineIds[detailKey(state, boxId)];
            if (boxId !== undefined && lineId !== undefined) {
                return { boxId, id: lineId, kind: "line" };
            }
            return boxId === undefined ? undefined : { id: boxId, kind: "box" };
        }
        if (scope === "boxDetail") {
            const state = this.#store.getState();
            const boxId = state.ui.mainFocusId;
            if (boxId === undefined) {
                return undefined;
            }
            const key = detailKey(state, boxId);
            const lineId = state.interaction.selectedDetailLineIds[key];
            return lineId === undefined ? undefined : { boxId, id: lineId, kind: "line" };
        }
        if (scope === "confirm") {
            return { id: this.#store.getState().interaction.selectedConfirmButton, kind: "button" };
        }
        if (scope === "approvalDetail" || scope === "denyConfirm") {
            const action = this.#store.getState().interaction.auditPage.selectedAction;
            return action === undefined ? undefined : { id: action, kind: "approvalAction" };
        }
        if (scope === "search") {
            return { id: "search.query", kind: "field" };
        }
        if (scope === "toolForm") {
            return { id: "toolForm.input", kind: "field" };
        }
        if (scope === "form" || scope === "wizard") {
            const state = this.#store.getState();
            const boxId = state.ui.mainFocusId;
            if (boxId === undefined) {
                return undefined;
            }
            const lineId = state.interaction.selectedDetailLineIds[detailKey(state, boxId)];
            return lineId === undefined ? undefined : { id: lineId, kind: lineId.includes(":button:") ? "button" : "field" };
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
        const graph = this.#context.graphFor(page, focusModeFor(item, this.currentMode()));

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
                this.#store.setSelectedDetailLine(detailKey(this.#store.getState(), item.id), undefined);
                return;
            case "line": {
                const state = this.#store.getState();
                this.#store.setFocusScope("mainBoxes");
                this.#store.setMainFocusId(item.boxId);
                this.#store.setSelectedDetailLine(detailKey(state, item.boxId), item.id);
                return;
            }
            case "approvalAction": {
                const state = this.#store.getState();
                this.#store.setAuditPage({
                    ...state.interaction.auditPage,
                    selectedAction: item.id
                });
                return;
            }
            case "button":
                if (this.currentMode() === "form" || this.currentMode() === "wizard") {
                    const state = this.#store.getState();
                    const boxId = state.ui.mainFocusId;
                    if (boxId !== undefined) {
                        this.#store.setSelectedDetailLine(detailKey(state, boxId), item.id);
                    }
                    return;
                }
                this.#store.setFocusScope("confirm");
                this.#store.setConfirmFocus(item.id === "confirm" ? "confirm" : "cancel");
                return;
            case "field":
                if (this.currentMode() === "form" || this.currentMode() === "wizard") {
                    const state = this.#store.getState();
                    const boxId = state.ui.mainFocusId;
                    if (boxId !== undefined) {
                        this.#store.setSelectedDetailLine(detailKey(state, boxId), item.id);
                    }
                    return;
                }
                this.#store.setFocusScope(this.currentMode() === "toolForm" ? "toolForm" : "search");
                return;
        }
    }
}

function detailKey(state: TuiAppState, boxId: string): string {
    if (state.ui.selectedPage === "oauth") {
        return `oauth:undefined:${boxId}`;
    }

    if (state.ui.selectedPage === "instances" && boxId.startsWith("instance:")) {
        return `instances:${boxId.slice("instance:".length)}:instance`;
    }

    if (state.ui.selectedPage === "instances" && boxId === "create-wizard") {
        return "instances:all:create-wizard";
    }

    if (state.ui.selectedPage === "instances" && boxId === "create-instance") {
        return "instances:undefined:create-instance";
    }

    return `${state.ui.selectedPage}:${state.ui.selectedInstance}:${boxId}`;
}

function focusModeFor(item: FocusItem, current: TuiMode): TuiMode {
    switch (item.kind) {
        case "page":
            return "sidebarPages";
        case "instance":
            return "sidebarInstances";
        case "box":
            return "mainBoxes";
        case "line":
            return "mainBoxes";
        case "approvalAction":
            return current === "denyConfirm" ? "denyConfirm" : "approvalDetail";
        case "button":
            return "confirm";
        case "field":
            return current === "toolForm" ? "toolForm" : "search";
    }
}
