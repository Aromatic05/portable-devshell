import type { TuiAppStore } from "../store/TuiAppStore.js";
import { buildFocusGraphForState, buildScreenDefinition, nextPanel, previousPanel } from "../screen/ScreenRouter.js";
import { TuiFocusManager } from "./TuiFocusManager.js";
import { isSameFocusItem, type TuiUiIntent } from "./TuiInteractionTypes.js";

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
                if (this.#store.getState().interaction.dirty) {
                    this.#openConfirm({
                        body: "Discard local changes and exit the TUI?",
                        confirmIntent: { type: "app.quit" },
                        confirmLabel: "Quit",
                        title: "Confirm Exit"
                    });
                    return true;
                }

                await this.#onQuit();
                return true;
            case "app.quit":
                await this.#onQuit();
                return true;
            case "panel.activate":
                this.#store.setActivePanel(intent.panel);
                this.#store.setMode("normal");
                this.#focusManager.syncPanel(intent.panel, this.#store.getState().interaction.mode);
                if (intent.panel === "logs") {
                    await this.#onLogsReload();
                    this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                }
                return true;
            case "panel.cycle": {
                const panel = this.#store.getState().activePanel;
                return await this.dispatch({
                    panel: intent.direction === "next" ? nextPanel(panel) : previousPanel(panel),
                    type: "panel.activate"
                });
            }
            case "focus.move":
                if (this.#store.getState().activePanel === "logs" && (intent.direction === "up" || intent.direction === "down")) {
                    return this.#handleLogsLineMove(intent.direction);
                }

                return this.#focusManager.move(intent.direction);
            case "focus.set":
                return this.#focusManager.setFocus(intent.item);
            case "focus.activate": {
                const item = this.#store.getState().interaction.currentFocus;
                return item === undefined ? false : await this.dispatch({ item, type: "focus.activateItem" });
            }
            case "focus.activateItem":
                for (const nextIntent of buildScreenDefinition(this.#store.getState()).activate(intent.item, this.#store.getState())) {
                    await this.dispatch(nextIntent);
                }
                return true;
            case "ui.cancel":
                return await this.#cancel();
            case "ui.help":
                return await this.dispatch({ panel: "help", type: "panel.activate" });
            case "ui.redraw":
                this.#store.bumpRedrawNonce();
                this.#onRedraw();
                return true;
            case "search.open":
                this.#focusManager.pushRestore("search");
                this.#store.setSearchOpen(true);
                this.#store.setCurrentFocus({ kind: "field", id: "search.query" });
                return true;
            case "search.append":
                this.#store.setSearchQuery(`${this.#store.getState().interaction.search.query}${intent.text}`);
                return true;
            case "search.backspace":
                this.#store.setSearchQuery(this.#store.getState().interaction.search.query.slice(0, -1));
                return true;
            case "search.submit":
                this.#store.setSearchOpen(false);
                this.#focusManager.restore();
                this.#focusManager.syncPanel(this.#store.getState().activePanel, this.#store.getState().interaction.mode);
                return true;
            case "actionMenu.open": {
                const definition = buildScreenDefinition(this.#store.getState());
                if (definition.actionMenu.items.length === 0) {
                    return false;
                }

                this.#focusManager.pushRestore("actionMenu");
                this.#store.setActionMenu(definition.actionMenu.title, definition.actionMenu.items);
                this.#store.setCurrentFocus({ kind: "action", id: definition.actionMenu.items[0]?.id ?? "" });
                return true;
            }
            case "actionMenu.move": {
                const moved = this.#focusManager.move(intent.direction);
                const focused = this.#store.getState().interaction.currentFocus;

                if (focused?.kind === "action") {
                    const selectedIndex = this.#store.getState().interaction.actionMenu.items.findIndex((item) => item.id === focused.id);
                    if (selectedIndex >= 0) {
                        this.#store.setActionMenu(
                            this.#store.getState().interaction.actionMenu.title,
                            this.#store.getState().interaction.actionMenu.items,
                            selectedIndex
                        );
                    }
                }

                return moved;
            }
            case "actionMenu.submit": {
                const focused = this.#store.getState().interaction.currentFocus;
                const item = this.#store.getState().interaction.actionMenu.items.find((entry) => focused?.kind === "action" && entry.id === focused.id);

                if (item === undefined) {
                    return false;
                }

                this.#store.setActionMenu("", []);
                this.#focusManager.restore();
                await this.dispatch(item.intent);
                return true;
            }
            case "confirm.accept": {
                const focus = this.#store.getState().interaction.currentFocus;

                if (focus?.kind === "button" && focus.id === "cancel") {
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
                return await this.#dispatchScreenIntent("pageUp");
            case "screen.pageDown":
                return await this.#dispatchScreenIntent("pageDown");
            case "screen.home":
                return await this.#dispatchScreenIntent("home");
            case "screen.end":
                return await this.#dispatchScreenIntent("end");
            case "screen.toggle": {
                const focused = this.#store.getState().interaction.currentFocus;
                if (focused === undefined) {
                    return false;
                }

                for (const nextIntent of buildScreenDefinition(this.#store.getState()).toggle(focused, this.#store.getState())) {
                    await this.dispatch(nextIntent);
                }
                return true;
            }
            case "edit.setDirty":
                this.#store.setDirty(intent.value);
                if (!intent.value && this.#store.getState().interaction.mode === "edit") {
                    this.#store.setMode("normal");
                }
                return true;
            case "logs.reload":
                if (this.#store.getState().activePanel !== "logs") {
                    return false;
                }

                await this.#onLogsReload();
                this.#store.setScreenStatus("logs", "Logs reloaded from instance.readLogs.");
                return true;
            case "logs.toggleFollow":
                if (this.#store.getState().activePanel !== "logs") {
                    return false;
                }

                const nextFollow = !this.#store.getState().interaction.logsViewport.follow;
                this.#store.setLogsFollow(nextFollow);
                this.#store.setScreenStatus(
                    "logs",
                    nextFollow ? "Follow enabled." : "Follow paused."
                );
                return true;
            case "logs.clearBuffer":
                if (this.#store.getState().activePanel !== "logs") {
                    return false;
                }

                this.#store.clearLogsBuffer();
                this.#store.setScreenStatus("logs", "Cleared local log buffer only.");
                return true;
            case "mode.set":
                this.#store.setMode(intent.mode);
                this.#focusManager.syncPanel(this.#store.getState().activePanel, intent.mode);
                return true;
            case "overlay.openActionMenu":
                this.#focusManager.pushRestore("actionMenu");
                this.#store.setActionMenu(intent.title, intent.items);
                this.#store.setCurrentFocus({ kind: "action", id: intent.items[0]?.id ?? "" });
                return true;
            case "overlay.openConfirm":
                this.#openConfirm(intent);
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
            case "ui.toggleExpanded":
                this.#store.toggleExpanded(intent.key);
                return true;
            case "screen.setStatus":
                this.#store.setScreenStatus(intent.panel, intent.status);
                return true;
            case "screen.setToggle":
                this.#store.setScreenToggle(intent.panel, intent.value);
                return true;
            case "screen.clearStatus":
                this.#store.setScreenStatus(this.#store.getState().activePanel, undefined);
                return true;
        }
    }

    async dispatchMany(intents: readonly TuiUiIntent[]): Promise<void> {
        for (const intent of intents) {
            await this.dispatch(intent);
        }
    }

    async #cancel(): Promise<boolean> {
        const state = this.#store.getState();

        if (state.interaction.mode === "actionMenu") {
            this.#store.setActionMenu("", []);
            this.#focusManager.restore();
            return true;
        }

        if (state.interaction.mode === "confirm") {
            return await this.dispatch({ type: "confirm.cancel" });
        }

        if (state.interaction.mode === "search") {
            this.#store.setSearchOpen(false);
            this.#focusManager.restore();
            return true;
        }

        return false;
    }

    async #dispatchScreenIntent(intent: "end" | "home" | "pageDown" | "pageUp"): Promise<boolean> {
        if (this.#store.getState().activePanel === "logs") {
            return this.#handleLogsViewportIntent(intent);
        }

        const definition = buildScreenDefinition(this.#store.getState());

        for (const nextIntent of definition.handleIntent(intent, this.#store.getState())) {
            await this.dispatch(nextIntent);
        }

        return true;
    }

    #openConfirm(input: { body: string; confirmIntent: TuiUiIntent; confirmLabel?: string; title: string }): void {
        this.#focusManager.pushRestore("confirm");
        this.#store.setConfirmDialog({
            body: input.body,
            confirmIntent: input.confirmIntent,
            confirmLabel: input.confirmLabel ?? "Confirm",
            open: true,
            title: input.title
        });
        const graph = buildFocusGraphForState(this.#store.getState());
        const cancelFocus = graph.first();
        this.#store.setCurrentFocus(cancelFocus);
    }

    #handleLogsViewportIntent(intent: "end" | "home" | "pageDown" | "pageUp"): boolean {
        const state = this.#store.getState();
        const totalLines = Object.values(state.logsByInstance).reduce((count, entries) => count + entries.length, 0);
        const pageSize = 14;
        const maxTopIndex = Math.max(0, totalLines - pageSize);
        const currentTop = state.interaction.logsViewport.follow ? maxTopIndex : state.interaction.logsViewport.topIndex;

        if (intent === "end") {
            this.#store.setLogsViewport(maxTopIndex, true);
            this.#store.setScreenStatus("logs", "Moved to log end and resumed follow.");
            return true;
        }

        if (intent === "home") {
            this.#store.setLogsViewport(0, false);
            this.#store.setScreenStatus("logs", "Moved to log start and paused follow.");
            return true;
        }

        const delta = intent === "pageDown" ? pageSize : -pageSize;
        const nextTop = Math.max(0, Math.min(maxTopIndex, currentTop + delta));
        const follow = nextTop >= maxTopIndex;

        this.#store.setLogsViewport(nextTop, follow);
        this.#store.setScreenStatus("logs", follow ? "Reached log end and resumed follow." : "Scrolled logs and paused follow.");
        return true;
    }

    #handleLogsLineMove(direction: "down" | "up"): boolean {
        const state = this.#store.getState();
        const totalLines = Object.values(state.logsByInstance).reduce((count, entries) => count + entries.length, 0);
        const pageSize = 14;
        const maxTopIndex = Math.max(0, totalLines - pageSize);
        const currentTop = state.interaction.logsViewport.follow ? maxTopIndex : state.interaction.logsViewport.topIndex;
        const delta = direction === "down" ? 1 : -1;
        const nextTop = Math.max(0, Math.min(maxTopIndex, currentTop + delta));
        const follow = nextTop >= maxTopIndex;

        this.#store.setLogsViewport(nextTop, follow);
        if (!follow && direction === "up") {
            this.#store.setScreenStatus("logs", "Manual scroll paused follow.");
        }

        if (follow && direction === "down") {
            this.#store.setScreenStatus("logs", "Reached log end and resumed follow.");
        }

        return true;
    }
}
