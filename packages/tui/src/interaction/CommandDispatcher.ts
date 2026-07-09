import type { TuiAppStore } from "../store/TuiAppStore.js";
import { buildFocusGraphForState } from "../screen/ScreenRouter.js";
import { TuiFocusManager } from "./TuiFocusManager.js";
import type { TuiUiIntent } from "./TuiInteractionTypes.js";
import { selectMainBoxIds } from "../store/TuiSelectors.js";

export interface CommandDispatcherOptions {
    focusManager: TuiFocusManager;
    onLogsReload(): Promise<void>;
    onQuit(): Promise<void>;
    onRedraw(): void;
    store: TuiAppStore;
}

export class CommandDispatcher {
    readonly #focusManager: TuiFocusManager;
    readonly #onLogsReload: () => Promise<void>;
    readonly #onQuit: () => Promise<void>;
    readonly #onRedraw: () => void;
    readonly #store: TuiAppStore;

    constructor(options: CommandDispatcherOptions) {
        this.#focusManager = options.focusManager;
        this.#onLogsReload = options.onLogsReload;
        this.#onQuit = options.onQuit;
        this.#onRedraw = options.onRedraw;
        this.#store = options.store;
    }

    async dispatch(intent: TuiUiIntent): Promise<boolean> {
        switch (intent.type) {
            case "app.requestQuit":
            case "app.quit":
                await this.#onQuit();
                return true;
            case "page.select":
                this.#store.setSelectedPage(intent.page);
                this.#syncMainFocus();
                if (intent.page === "logs" && this.#store.getState().ui.selectedInstance !== undefined) {
                    await this.#onLogsReload();
                    this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                }
                return true;
            case "focus.move":
                if (intent.direction === "next" || intent.direction === "previous") {
                    return this.#moveAcrossScopes(intent.direction);
                }
                return this.#moveWithinScope(intent.direction);
            case "focus.activate":
                return await this.#activateCurrentScope();
            case "ui.cancel":
                return this.#cancel();
            case "ui.help":
                return await this.dispatch({ page: "help", type: "page.select" });
            case "ui.redraw":
                this.#store.bumpRedrawNonce();
                this.#onRedraw();
                return true;
            case "search.open":
                this.#focusManager.pushRestore("search");
                this.#store.setSearchOpen(true);
                this.#store.setFocusScope("search");
                return true;
            case "search.append": {
                const page = this.#store.getState().ui.selectedPage;
                const current = this.#store.getState().ui.searchQueries[page] ?? "";
                this.#store.setSearchQuery(page, `${current}${intent.text}`);
                return true;
            }
            case "search.backspace": {
                const page = this.#store.getState().ui.selectedPage;
                const current = this.#store.getState().ui.searchQueries[page] ?? "";
                this.#store.setSearchQuery(page, current.slice(0, -1));
                return true;
            }
            case "search.submit":
                this.#store.setSearchOpen(false);
                this.#focusManager.restore();
                return true;
            case "actionMenu.open":
                this.#focusManager.pushRestore("actionMenu");
                this.#store.setActionMenu("Read-only", [
                    {
                        id: "readonly.placeholder",
                        intent: {
                            page: this.#store.getState().ui.selectedPage,
                            status: "Read-only action menu placeholder.",
                            type: "screen.setStatus"
                        },
                        label: "Read-only placeholder"
                    }
                ]);
                this.#store.setFocusScope("actionMenu");
                return true;
            case "actionMenu.move": {
                const items = this.#store.getState().interaction.actionMenu.items;
                if (items.length === 0) {
                    return false;
                }
                const current = this.#store.getState().interaction.actionMenu.selectedIndex;
                const next = intent.direction === "down" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
                this.#store.setActionMenu(this.#store.getState().interaction.actionMenu.title, items, next);
                return true;
            }
            case "actionMenu.submit": {
                const selectedIndex = this.#store.getState().interaction.actionMenu.selectedIndex;
                const item = this.#store.getState().interaction.actionMenu.items[selectedIndex];
                if (item === undefined) {
                    return false;
                }
                this.#store.setActionMenu("", []);
                this.#focusManager.restore();
                return await this.dispatch(item.intent);
            }
            case "confirm.accept": {
                if (this.#store.getState().interaction.selectedConfirmButton === "cancel") {
                    return await this.dispatch({ type: "confirm.cancel" });
                }
                const confirmIntent = this.#store.getState().interaction.confirmDialog.confirmIntent;
                this.#store.setConfirmDialog({
                    body: "",
                    confirmIntent: { type: "ui.cancel" },
                    open: false,
                    title: ""
                });
                this.#focusManager.restore();
                return await this.dispatch(confirmIntent);
            }
            case "confirm.cancel":
                this.#store.setConfirmDialog({
                    body: "",
                    confirmIntent: { type: "ui.cancel" },
                    open: false,
                    title: ""
                });
                this.#focusManager.restore();
                return true;
            case "screen.pageUp":
                return this.#scrollCurrentBox(-12);
            case "screen.pageDown":
                return this.#scrollCurrentBox(12);
            case "screen.home":
                return this.#setCurrentBoxOffset(0);
            case "screen.end":
                return this.#setCurrentBoxOffset(Number.MAX_SAFE_INTEGER);
            case "screen.toggle": {
                if (this.#store.getState().interaction.focusScope !== "mainBoxes") {
                    return false;
                }
                const boxId = this.#store.getState().ui.mainFocusId;
                if (boxId === undefined) {
                    return false;
                }
                const key = this.#expandedKey(boxId);
                const expanded = this.#store.getState().ui.expandedBoxes[key] === true;
                this.#store.toggleExpanded(key);
                this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, expanded ? "Collapsed box." : "Expanded box.");
                return true;
            }
            case "logs.reload":
                if (this.#store.getState().ui.selectedPage !== "logs" || this.#store.getState().ui.selectedInstance === undefined) {
                    return false;
                }
                await this.#onLogsReload();
                this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                return true;
            case "logs.toggleFollow":
                this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, "Use Up/Down/Home/End to inspect log history.");
                return true;
            case "logs.clearBuffer":
                if (this.#store.getState().ui.selectedPage !== "logs") {
                    return false;
                }
                this.#store.clearLogsBuffer();
                this.#store.setScreenStatus("logs", "Cleared local log buffer only.");
                return true;
            case "overlay.openActionMenu":
                this.#focusManager.pushRestore("actionMenu");
                this.#store.setActionMenu(intent.title, intent.items);
                this.#store.setFocusScope("actionMenu");
                return true;
            case "overlay.openConfirm":
                this.#focusManager.pushRestore("confirm");
                this.#store.setConfirmDialog({
                    body: intent.body,
                    cancelLabel: intent.cancelLabel,
                    confirmIntent: intent.confirmIntent,
                    confirmLabel: intent.confirmLabel,
                    open: true,
                    title: intent.title
                });
                this.#store.setFocusScope("confirm");
                return true;
            case "overlay.closeActionMenu":
                this.#store.setActionMenu("", []);
                this.#focusManager.restore();
                return true;
            case "overlay.closeConfirm":
                this.#store.setConfirmDialog({
                    body: "",
                    confirmIntent: { type: "ui.cancel" },
                    open: false,
                    title: ""
                });
                this.#focusManager.restore();
                return true;
            case "focus.scope.set":
                this.#store.setFocusScope(intent.focusScope);
                return true;
            case "mainFocus.set":
                this.#store.setMainFocusId(intent.id);
                return true;
            case "confirm.focus":
                this.#store.setConfirmFocus(intent.button);
                return true;
            case "ui.toggleExpanded":
                this.#store.toggleExpanded(intent.key);
                return true;
            case "screen.setStatus":
                this.#store.setScreenStatus(intent.page, intent.status);
                return true;
            case "screen.clearStatus":
                this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, undefined);
                return true;
        }
    }

    async dispatchMany(intents: readonly TuiUiIntent[]): Promise<void> {
        for (const intent of intents) {
            await this.dispatch(intent);
        }
    }

    #cancel(): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "actionMenu") {
            this.#store.setActionMenu("", []);
            this.#focusManager.restore();
            return true;
        }
        if (scope === "confirm") {
            void this.dispatch({ type: "confirm.cancel" });
            return true;
        }
        if (scope === "search") {
            this.#store.setSearchOpen(false);
            this.#focusManager.restore();
            return true;
        }
        if (scope === "boxDetail") {
            this.#store.setFocusScope("mainBoxes");
            return true;
        }
        if (scope === "mainBoxes") {
            if (this.#store.getState().ui.selectedInstance !== undefined) {
                this.#store.setSidebarFocus("instances");
                this.#store.setFocusScope("sidebarInstances");
            } else {
                this.#store.setSidebarFocus("pages");
                this.#store.setFocusScope("sidebarPages");
            }
            return true;
        }
        if (scope === "sidebarInstances") {
            this.#store.setSidebarFocus("pages");
            this.#store.setFocusScope("sidebarPages");
            return true;
        }
        return false;
    }

    #moveAcrossScopes(direction: "next" | "previous"): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        const hasInstances = this.#store.getState().instances.length > 0;
        const boxIds = selectMainBoxIds(this.#store.getState());
        const hasBoxes = boxIds.length > 0;

        if (scope === "confirm") {
            return this.#focusManager.move(direction);
        }

        if (direction === "next") {
            if (scope === "sidebarPages") {
                if (hasInstances) {
                    this.#store.setSidebarFocus("instances");
                    this.#store.setFocusScope("sidebarInstances");
                    return true;
                }
                if (hasBoxes) {
                    this.#store.setFocusScope("mainBoxes");
                    this.#syncMainFocus();
                    return true;
                }
                return false;
            }
            if (scope === "sidebarInstances") {
                if (hasBoxes) {
                    this.#store.setFocusScope("mainBoxes");
                    this.#syncMainFocus();
                    return true;
                }
                this.#store.setSidebarFocus("pages");
                this.#store.setFocusScope("sidebarPages");
                return true;
            }
            if (scope === "mainBoxes" || scope === "boxDetail") {
                this.#store.setSidebarFocus("pages");
                this.#store.setFocusScope("sidebarPages");
                return true;
            }
        }

        if (scope === "sidebarPages") {
            if (hasBoxes) {
                this.#store.setFocusScope("mainBoxes");
                this.#syncMainFocus();
                return true;
            }
            if (hasInstances) {
                this.#store.setSidebarFocus("instances");
                this.#store.setFocusScope("sidebarInstances");
                return true;
            }
            return false;
        }
        if (scope === "sidebarInstances") {
            this.#store.setSidebarFocus("pages");
            this.#store.setFocusScope("sidebarPages");
            return true;
        }
        if (scope === "mainBoxes" || scope === "boxDetail") {
            if (hasInstances) {
                this.#store.setSidebarFocus("instances");
                this.#store.setFocusScope("sidebarInstances");
                return true;
            }
            this.#store.setSidebarFocus("pages");
            this.#store.setFocusScope("sidebarPages");
            return true;
        }
        return false;
    }

    #moveWithinScope(direction: "up" | "down" | "left" | "right"): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "mainBoxes" && this.#store.getState().ui.selectedPage === "logs" && selectMainBoxIds(this.#store.getState()).length <= 1) {
            return this.#scrollCurrentBox(direction === "up" ? -1 : direction === "down" ? 1 : 0);
        }
        if (scope === "boxDetail") {
            if (direction === "up") {
                return this.#scrollCurrentBox(-1);
            }
            if (direction === "down") {
                return this.#scrollCurrentBox(1);
            }
            return false;
        }
        return this.#focusManager.move(direction);
    }

    async #activateCurrentScope(): Promise<boolean> {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "sidebarPages" && this.#store.getState().ui.selectedPage === "logs" && this.#store.getState().ui.selectedInstance !== undefined) {
            await this.#onLogsReload();
            this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
            return true;
        }
        if (scope === "mainBoxes") {
            if (this.#store.getState().ui.mainFocusId === undefined) {
                return false;
            }
            this.#store.setFocusScope("boxDetail");
            this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, "Opened box detail.");
            return true;
        }
        if (scope === "boxDetail") {
            this.#store.setScreenStatus(this.#store.getState().ui.selectedPage, "Read-only detail.");
            return true;
        }
        return true;
    }

    #syncMainFocus(): void {
        const boxIds = selectMainBoxIds(this.#store.getState());
        if (boxIds.length === 0) {
            this.#store.setMainFocusId(undefined);
            return;
        }
        const current = this.#store.getState().ui.mainFocusId;
        if (current === undefined || !boxIds.includes(current)) {
            this.#store.setMainFocusId(boxIds[0]);
        }
    }

    #expandedKey(boxId: string): string {
        const state = this.#store.getState();
        return `${state.ui.selectedPage}:${state.ui.selectedInstance}:${boxId}`;
    }

    #scrollCurrentBox(delta: number): boolean {
        const boxId = this.#store.getState().ui.mainFocusId;
        if (boxId === undefined) {
            return false;
        }
        const key = `${this.#store.getState().ui.selectedPage}:${this.#store.getState().ui.selectedInstance}:${boxId}`;
        const current = this.#store.getState().ui.scrollOffsets[key] ?? 0;
        const next = delta === 0 ? current : Math.max(0, current + delta);
        this.#store.setScrollOffset(key, next);
        return true;
    }

    #setCurrentBoxOffset(offset: number): boolean {
        const boxId = this.#store.getState().ui.mainFocusId;
        if (boxId === undefined) {
            return false;
        }
        const key = `${this.#store.getState().ui.selectedPage}:${this.#store.getState().ui.selectedInstance}:${boxId}`;
        this.#store.setScrollOffset(key, Math.max(0, offset));
        return true;
    }
}
