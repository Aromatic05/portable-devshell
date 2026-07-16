import type { TuiFocusManager } from "../../focus/TuiFocusManager.js";
import type { TuiUiIntent } from "../../interaction/TuiInteractionModel.js";
import type { TuiAppStore } from "../../store/TuiAppStore.js";
import {
    selectMainBoxIds,
    selectMainScreenModel
} from "../../store/TuiSelectors.js";
import type { TuiPageId } from "../../ui/TuiUiModel.js";
import type { TuiCommandDispatcherFocus } from "./TuiCommandDispatcherFocus.js";

export interface TuiCommandDispatcherNavigationOptions {
    dispatch?(intent: TuiUiIntent): Promise<boolean>;
    focus: TuiCommandDispatcherFocus;
    focusManager: TuiFocusManager;
    onLogsReload(): Promise<void>;
    onPageReload(page: TuiPageId, instance: string | undefined): Promise<void>;
    onRedraw(): void;
    store: TuiAppStore;
}

export class TuiCommandDispatcherNavigation {
    readonly #dispatch?: (intent: TuiUiIntent) => Promise<boolean>;
    readonly #focus: TuiCommandDispatcherFocus;
    readonly #focusManager: TuiFocusManager;
    readonly #onLogsReload: () => Promise<void>;
    readonly #onPageReload: TuiCommandDispatcherNavigationOptions["onPageReload"];
    readonly #onRedraw: () => void;
    readonly #store: TuiAppStore;

    constructor(options: TuiCommandDispatcherNavigationOptions) {
        this.#dispatch = options.dispatch;
        this.#focus = options.focus;
        this.#focusManager = options.focusManager;
        this.#onLogsReload = options.onLogsReload;
        this.#onPageReload = options.onPageReload;
        this.#onRedraw = options.onRedraw;
        this.#store = options.store;
    }

    async dispatch(intent: TuiUiIntent): Promise<boolean | undefined> {
        switch (intent.type) {
            case "page.select":
                return await this.#selectPage(intent.page);
            case "instance.selectIndex":
                return this.#selectInstanceIndex(intent.index);
            case "page.reload":
                return await this.#reloadPage();
            case "focus.move":
                if (
                    intent.direction === "next" ||
                    intent.direction === "previous"
                ) {
                    return this.#moveAcrossScopes(intent.direction);
                }
                return this.#moveWithinScope(intent.direction);
            case "ui.help":
                return await this.#selectPage("help");
            case "ui.redraw":
                this.#store.bumpRedrawNonce();
                this.#onRedraw();
                return true;
            case "search.open":
                return this.#openSearch();
            case "search.append":
                return this.#updateSearch((current) => {
                    return `${current}${intent.text}`;
                });
            case "search.backspace":
                return this.#updateSearch((current) => current.slice(0, -1));
            case "search.submit":
                this.#store.setSearchOpen(false);
                this.#focusManager.restore();
                return true;
            case "confirm.accept":
                return await this.#acceptConfirm();
            case "confirm.cancel":
            case "overlay.closeConfirm":
                this.#closeConfirm();
                return true;
            case "screen.pageUp":
                this.#focus.pauseLogFollow();
                return this.#focus.scrollMainColumn(
                    -Math.max(1, this.#focus.boxViewportRows() - 1)
                );
            case "screen.pageDown":
                return this.#focus.scrollMainColumn(
                    Math.max(1, this.#focus.boxViewportRows() - 1)
                );
            case "screen.home":
                this.#focus.pauseLogFollow();
                return this.#focus.setMainColumnOffset(0);
            case "screen.end":
                return this.#focus.setMainColumnOffset(
                    this.#focus.maxMainScrollOffset()
                );
            case "screen.toggle":
                return this.#toggleCurrentBox();
            case "textDetail.open":
                this.#focusManager.pushRestore("textDetail");
                this.#store.setTextDetail({
                    body: intent.body,
                    open: true,
                    title: intent.title
                });
                this.#store.setFocusScope("textDetail");
                return true;
            case "textDetail.close":
                this.#closeTextDetail();
                return true;
            case "textDetail.scroll":
                this.#scrollTextDetail(intent.delta);
                return true;
            case "logs.toggleFollow":
                return this.#toggleLogsFollow();
            case "logs.clearBuffer":
                return this.#clearLogsBuffer();
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
                this.#store.setScreenStatus(
                    this.#store.getState().ui.selectedPage,
                    undefined
                );
                return true;
            default:
                return undefined;
        }
    }

    async activateSidebarSelection(): Promise<boolean> {
        const cursor = this.#store.getState().interaction.sidebarCursor;
        if (cursor?.kind === "page") {
            this.#store.setSelectedPage(cursor.id);
        } else if (cursor?.kind === "instance") {
            this.#store.setSelectedInstance(cursor.id);
        } else {
            return false;
        }
        this.#focus.syncMainFocus();
        await this.#reloadLogsIfSelected();
        return true;
    }

    cancelPassiveScope(): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "textDetail") {
            this.#closeTextDetail();
            return true;
        }
        if (scope === "confirm") {
            this.#closeConfirm();
            return true;
        }
        if (scope === "search") {
            this.#store.setSearchOpen(false);
            this.#focusManager.restore();
            return true;
        }
        if (scope === "toolForm") {
            this.#store.clearToolForm();
            this.#focusManager.restore();
            return true;
        }
        if (scope === "boxDetail") {
            this.#store.setFocusScope("mainBoxes");
            return true;
        }
        if (scope === "mainBoxes") {
            this.returnToSidebar();
            return true;
        }
        if (scope === "sidebarInstances") {
            this.#store.setSidebarCursor({
                id: this.#store.getState().ui.selectedPage,
                kind: "page"
            });
            this.#store.setFocusScope("sidebarPages");
            return true;
        }
        return false;
    }

    returnToSidebar(): void {
        const cursor = this.#store.getState().interaction.sidebarCursor;
        this.#store.setFocusScope(
            cursor?.kind === "instance"
                ? "sidebarInstances"
                : "sidebarPages"
        );
    }

    async #selectPage(page: TuiPageId): Promise<boolean> {
        this.#store.setSelectedPage(page);
        this.#store.setSidebarCursor({ id: page, kind: "page" });
        this.#focus.syncMainFocus();
        await this.#reloadLogsIfSelected();
        return true;
    }

    #selectInstanceIndex(index: number): boolean {
        const entry = this.#store.getState().instances[index];
        if (entry === undefined) {
            this.#store.setScreenStatus(
                this.#store.getState().ui.selectedPage,
                `Instance ${index + 1} is unavailable.`
            );
            return false;
        }
        this.#store.setSelectedInstance(entry.name);
        this.#store.setSidebarCursor({ id: entry.name, kind: "instance" });
        this.#focus.syncMainFocus();
        return true;
    }

    async #reloadPage(): Promise<boolean> {
        const state = this.#store.getState();
        try {
            await this.#onPageReload(
                state.ui.selectedPage,
                state.ui.selectedInstance
            );
            this.#store.setScreenStatus(
                state.ui.selectedPage,
                "Page reloaded."
            );
            this.#focus.syncMainFocus();
            return true;
        } catch (error) {
            this.#store.setScreenStatus(
                state.ui.selectedPage,
                `Reload failed: ${readErrorMessage(error)}`
            );
            return false;
        }
    }

    #openSearch(): boolean {
        const page = this.#store.getState().ui.selectedPage;
        if (!isSearchablePage(page)) {
            return false;
        }
        this.#focusManager.pushRestore("search");
        this.#store.setSearchOpen(true);
        this.#store.setFocusScope("search");
        return true;
    }

    #updateSearch(update: (value: string) => string): boolean {
        const page = this.#store.getState().ui.selectedPage;
        const current = this.#store.getState().ui.searchQueries[page] ?? "";
        this.#store.setSearchQuery(page, update(current));
        this.#focus.syncMainFocus();
        return true;
    }

    async #acceptConfirm(): Promise<boolean> {
        const interaction = this.#store.getState().interaction;
        if (interaction.selectedConfirmButton === "cancel") {
            this.#closeConfirm();
            return true;
        }
        const confirmIntent = interaction.confirmDialog.confirmIntent;
        this.#closeConfirm();
        if (this.#dispatch === undefined) {
            return false;
        }
        return await this.#dispatch(confirmIntent);
    }

    #closeConfirm(): void {
        this.#store.setConfirmDialog({
            body: "",
            confirmIntent: { type: "ui.cancel" },
            open: false,
            title: ""
        });
        this.#focusManager.restore();
    }

    #toggleCurrentBox(): boolean {
        if (this.#store.getState().interaction.focusScope !== "mainBoxes") {
            return false;
        }
        const boxId = this.#store.getState().ui.mainFocusId;
        if (boxId === undefined) {
            return false;
        }
        const key = this.#focus.expandedKey(boxId);
        const expanded = this.#store.getState().ui.expandedBoxes[key] === true;
        this.#store.toggleExpanded(key);
        if (expanded) {
            this.#store.setSelectedDetailLine(key, undefined);
        } else {
            const box = selectMainScreenModel(this.#store.getState()).boxes.find(
                (candidate) => candidate.id === boxId
            );
            this.#store.setSelectedDetailLine(
                key,
                box?.expandedLines[0]?.id
            );
        }
        this.#focus.ensureMainFocusVisible();
        this.#store.setScreenStatus(
            this.#store.getState().ui.selectedPage,
            expanded ? "Collapsed box." : "Expanded box."
        );
        return true;
    }

    #closeTextDetail(): void {
        this.#store.setTextDetail({ body: "", open: false, title: "" });
        this.#focusManager.restore();
    }

    #scrollTextDetail(delta: number): void {
        const detail = this.#store.getState().interaction.textDetail;
        this.#store.setTextDetail({
            ...detail,
            scrollOffset: Math.max(0, detail.scrollOffset + delta)
        });
    }

    #toggleLogsFollow(): boolean {
        const state = this.#store.getState();
        const instance = state.ui.selectedInstance;
        if (state.ui.selectedPage !== "logs" || instance === undefined) {
            return false;
        }
        const follow = state.ui.logsFollowByInstance[instance] === false;
        this.#store.setLogsFollow(instance, follow);
        if (follow) {
            this.#store.setLogsPausedAtSeq(instance, undefined);
            this.#focus.setMainColumnOffset(
                this.#focus.maxMainScrollOffset()
            );
        } else {
            this.#store.setLogsPausedAtSeq(
                instance,
                state.logsByInstance[instance]?.at(-1)?.seq
            );
        }
        this.#store.setScreenStatus(
            "logs",
            follow
                ? "Following new log entries."
                : "Log follow paused."
        );
        return true;
    }

    #clearLogsBuffer(): boolean {
        if (this.#store.getState().ui.selectedPage !== "logs") {
            return false;
        }
        this.#store.clearLogsBuffer();
        this.#store.setScreenStatus(
            "logs",
            "Cleared local log buffer only."
        );
        return true;
    }

    #moveAcrossScopes(direction: "next" | "previous"): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        const hasBoxes = selectMainBoxIds(this.#store.getState()).length > 0;
        if (
            scope === "confirm" ||
            scope === "approvalDetail" ||
            scope === "denyConfirm" ||
            scope === "form" ||
            scope === "wizard"
        ) {
            return this.#focusManager.move(direction);
        }
        if (scope === "sidebarPages" || scope === "sidebarInstances") {
            if (!hasBoxes) {
                return false;
            }
            this.#store.setFocusScope("mainBoxes");
            this.#focus.syncMainFocus();
            return true;
        }
        if (scope === "mainBoxes" || scope === "boxDetail") {
            this.returnToSidebar();
            return true;
        }
        return false;
    }

    #moveWithinScope(
        direction: "up" | "down" | "left" | "right"
    ): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "textDetail") {
            this.#closeTextDetail();
            return true;
        }
        if (scope === "approvalDetail" || scope === "denyConfirm") {
            return (direction === "up" || direction === "down") &&
                this.#focusManager.move(direction);
        }
        if (scope === "boxDetail" || scope === "form" || scope === "wizard") {
            if (direction === "left" && scope === "boxDetail") {
                this.returnToSidebar();
                return true;
            }
            return (direction === "up" || direction === "down") &&
                this.#focusManager.move(direction);
        }
        if (
            (scope === "sidebarPages" || scope === "sidebarInstances") &&
            direction === "right"
        ) {
            if (selectMainBoxIds(this.#store.getState()).length === 0) {
                return false;
            }
            this.#store.setFocusScope("mainBoxes");
            this.#focus.syncMainFocus();
            return true;
        }
        if (scope === "mainBoxes" && direction === "left") {
            this.returnToSidebar();
            return true;
        }
        const moved = this.#focusManager.move(direction);
        if (moved && scope === "mainBoxes") {
            this.#focus.ensureMainFocusVisible();
        }
        return moved;
    }

    async #reloadLogsIfSelected(): Promise<void> {
        const state = this.#store.getState();
        if (
            state.ui.selectedPage === "logs" &&
            state.ui.selectedInstance !== undefined
        ) {
            await this.#onLogsReload();
            this.#store.setScreenStatus(
                "logs",
                "Logs reloaded from instance.readLogs."
            );
        }
    }
}

function isSearchablePage(page: TuiPageId): boolean {
    return page === "instances" ||
        page === "config" ||
        page === "audit" ||
        page === "logs";
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
