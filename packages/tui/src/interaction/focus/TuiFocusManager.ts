import {
    type TuiFocusItem,
    isSameTuiFocusItem,
} from "../../state/focus/TuiFocusItem.js";
import type { TuiAppStore } from "../../state/TuiAppStore.js";
import { topTuiOverlay } from "../../state/overlay/TuiOverlay.js";
import {
    TuiFocusGraph,
    type TuiFocusDirection,
} from "../../state/focus/TuiFocusGraph.js";
import { resolveSelectedDetailLineId } from "../../state/focus/TuiDetailLineSelection.js";
import { type TuiMode } from "../../state/TuiInteractionState.js";
import type { TuiPageId } from "../../state/TuiUiState.js";

export interface TuiFocusManagerContext {
    currentPage(): TuiPageId;
    expandedKeyFor(boxId: string): string | undefined;
    graphFor(page: TuiPageId, mode: TuiMode): TuiFocusGraph;
    mode(): TuiMode;
}

export class TuiFocusManager {
    readonly #context: TuiFocusManagerContext;
    readonly #pageMemory = new Map<TuiPageId, TuiFocusItem>();
    readonly #restoreStack: Array<{
        focus?: TuiFocusItem;
        mode: TuiMode;
        page: TuiPageId;
    }> = [];
    readonly #store: TuiAppStore;

    constructor(store: TuiAppStore, context: TuiFocusManagerContext) {
        this.#store = store;
        this.#context = context;
    }

    currentFocus(): TuiFocusItem | undefined {
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
            return instance === undefined
                ? undefined
                : { id: instance, kind: "instance" };
        }
        if (scope === "mainBoxes") {
            const boxId = this.#store.getState().ui.mainFocusId;
            if (boxId === undefined) {
                return undefined;
            }
            const lineId = this.#resolveBoxLineId(boxId, "mainBoxes");
            return lineId === undefined
                ? { id: boxId, kind: "box" }
                : { boxId, id: lineId, kind: "line" };
        }
        if (scope === "boxDetail") {
            const boxId = this.#store.getState().ui.mainFocusId;
            if (boxId === undefined) {
                return undefined;
            }
            const lineId = this.#resolveBoxLineId(boxId, "boxDetail");
            return lineId === undefined
                ? undefined
                : { boxId, id: lineId, kind: "line" };
        }
        if (scope === "confirm") {
            const overlay = topTuiOverlay(
                this.#store.getState().interaction.overlays,
            );
            return overlay?.kind === "confirmation"
                ? { id: overlay.selectedAction, kind: "button" }
                : undefined;
        }
        if (scope === "approvalDetail" || scope === "denyConfirm") {
            const overlay = topTuiOverlay(
                this.#store.getState().interaction.overlays,
            );
            return overlay?.kind === "approval"
                ? { id: overlay.selectedAction, kind: "approvalAction" }
                : undefined;
        }
        if (scope === "textDetail") {
            return undefined;
        }
        if (scope === "search") {
            return { id: "search.query", kind: "field" };
        }
        if (scope === "toolForm") {
            return { id: "toolForm.input", kind: "field" };
        }
        if (scope === "contextConversation") {
            return undefined;
        }
        if (scope === "form" || scope === "wizard") {
            const state = this.#store.getState();
            const boxId = state.ui.mainFocusId;
            if (boxId === undefined) {
                return undefined;
            }
            const expandedKey = this.#context.expandedKeyFor(boxId);
            const lineId =
                expandedKey === undefined
                    ? undefined
                    : state.interaction.selectedDetailLineIds[expandedKey];
            return lineId === undefined
                ? undefined
                : {
                      id: lineId,
                      kind: lineId.includes(":button:") ? "button" : "field",
                  };
        }
        return undefined;
    }

    currentMode(): TuiMode {
        return this.#store.getState().interaction.focusScope;
    }

    currentPage(): TuiPageId {
        return this.#store.getState().ui.selectedPage;
    }

    syncPanel(page: TuiPageId, mode = this.currentMode()): void {
        const graph = this.#context.graphFor(page, mode);
        const remembered = this.#pageMemory.get(page);
        const current = this.currentFocus();
        const currentBoxId = current?.kind === "line"
            ? current.boxId
            : current?.kind === "box"
              ? current.id
              : undefined;
        const sameBoxLine = currentBoxId === undefined
            ? undefined
            : graph.firstLineInBox(currentBoxId);
        const nextFocus = graph.includes(current)
            ? current
            : sameBoxLine !== undefined
              ? sameBoxLine
            : graph.includes(remembered)
              ? remembered
              : graph.first();
        if (!isSameTuiFocusItem(nextFocus, current)) {
            this.#applyFocus(nextFocus);
        }

        if (nextFocus !== undefined) {
            this.#pageMemory.set(page, nextFocus);
        }
    }

    move(direction: TuiFocusDirection): boolean {
        const page = this.currentPage();
        const graph = this.#context.graphFor(page, this.currentMode());
        const next = graph.move(this.currentFocus(), direction);

        if (
            next === undefined ||
            isSameTuiFocusItem(next, this.currentFocus())
        ) {
            return false;
        }

        this.#applyFocus(next);
        this.#pageMemory.set(page, next);
        return true;
    }

    setFocus(item: TuiFocusItem): boolean {
        const page = this.currentPage();
        const graph = this.#context.graphFor(
            page,
            focusModeFor(item, this.currentMode()),
        );

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
            page: this.currentPage(),
        });
        this.#store.setFocusScope(mode);
    }

    restore(): boolean {
        const restored = this.#restoreStack.pop();

        if (restored === undefined) {
            return false;
        }

        this.#store.setFocusScope(restored.mode);
        if (this.currentPage() !== restored.page) {
            this.#store.setSelectedPage(restored.page);
        }
        this.syncPanel(restored.page, restored.mode);

        if (restored.focus !== undefined) {
            this.setFocus(restored.focus);
        }

        return true;
    }

    #resolveBoxLineId(boxId: string, mode: TuiMode): string | undefined {
        const expandedKey = this.#context.expandedKeyFor(boxId);
        const storedId =
            expandedKey === undefined
                ? undefined
                : this.#store.getState().interaction.selectedDetailLineIds[
                      expandedKey
                  ];
        const graph = this.#context.graphFor(this.currentPage(), mode);
        return resolveSelectedDetailLineId(
            graph.lineIdsInBox(boxId),
            storedId,
        );
    }

    #applyFocus(item: TuiFocusItem | undefined): void {
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
            case "box": {
                this.#store.setFocusScope("mainBoxes");
                this.#store.setMainFocusId(item.id);
                return;
            }
            case "line": {
                this.#store.setFocusScope("mainBoxes");
                this.#store.setMainFocusId(item.boxId);
                const expandedKey = this.#context.expandedKeyFor(item.boxId);
                if (expandedKey !== undefined) {
                    this.#store.setSelectedDetailLine(expandedKey, item.id);
                }
                return;
            }
            case "approvalAction": {
                const overlay = topTuiOverlay(
                    this.#store.getState().interaction.overlays,
                );
                if (overlay?.kind === "approval") {
                    this.#store.replaceTopOverlay({
                        ...overlay,
                        selectedAction: item.id,
                    });
                }
                return;
            }
            case "button": {
                if (
                    this.currentMode() === "form" ||
                    this.currentMode() === "wizard"
                ) {
                    const state = this.#store.getState();
                    const boxId = state.ui.mainFocusId;
                    if (boxId !== undefined) {
                        const expandedKey = this.#context.expandedKeyFor(boxId);
                        if (expandedKey !== undefined) {
                            this.#store.setSelectedDetailLine(
                                expandedKey,
                                item.id,
                            );
                        }
                    }
                    return;
                }
                const overlay = topTuiOverlay(
                    this.#store.getState().interaction.overlays,
                );
                if (overlay?.kind === "confirmation") {
                    this.#store.setFocusScope("confirm");
                    this.#store.replaceTopOverlay({
                        ...overlay,
                        selectedAction:
                            item.id === "confirm" ? "confirm" : "cancel",
                    });
                }
                return;
            }
            case "field":
                if (
                    this.currentMode() === "form" ||
                    this.currentMode() === "wizard"
                ) {
                    const state = this.#store.getState();
                    const boxId = state.ui.mainFocusId;
                    if (boxId !== undefined) {
                        const expandedKey = this.#context.expandedKeyFor(boxId);
                        if (expandedKey !== undefined) {
                            this.#store.setSelectedDetailLine(
                                expandedKey,
                                item.id,
                            );
                        }
                    }
                    return;
                }
                this.#store.setFocusScope(
                    this.currentMode() === "toolForm" ? "toolForm" : "search",
                );
                return;
        }
    }
}

function focusModeFor(item: TuiFocusItem, current: TuiMode): TuiMode {
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
