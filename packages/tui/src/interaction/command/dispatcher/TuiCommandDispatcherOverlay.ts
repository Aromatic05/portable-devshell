import type { TuiUiIntent } from "../../../state/TuiInteractionState.js";
import type { TuiAppStore } from "../../../state/TuiAppStore.js";
import type { TuiFocusManager } from "../../focus/TuiFocusManager.js";
import type { TuiCommandDispatcherFocus } from "./TuiCommandDispatcherFocus.js";

export interface TuiCommandDispatcherOverlayOptions {
    dispatch?(intent: TuiUiIntent): Promise<boolean>;
    focus: TuiCommandDispatcherFocus;
    focusManager: TuiFocusManager;
    store: TuiAppStore;
}

export class TuiCommandDispatcherOverlay {
    readonly #dispatch?: (intent: TuiUiIntent) => Promise<boolean>;
    readonly #focus: TuiCommandDispatcherFocus;
    readonly #focusManager: TuiFocusManager;
    readonly #store: TuiAppStore;

    constructor(options: TuiCommandDispatcherOverlayOptions) {
        this.#dispatch = options.dispatch;
        this.#focus = options.focus;
        this.#focusManager = options.focusManager;
        this.#store = options.store;
    }

    async dispatch(intent: TuiUiIntent): Promise<boolean | undefined> {
        switch (intent.type) {
            case "search.open":
                return this.#openSearch();
            case "search.append":
                return this.#updateSearch((current) => `${current}${intent.text}`);
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
            case "textDetail.open":
                this.#focusManager.pushRestore("textDetail");
                this.#store.setTextDetail({
                    body: intent.body,
                    image: intent.image,
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
            default:
                return undefined;
        }
    }

    cancelPassiveScope(): boolean {
        switch (this.#store.getState().interaction.focusScope) {
            case "textDetail":
                this.#closeTextDetail();
                return true;
            case "confirm":
                this.#closeConfirm();
                return true;
            case "search":
                this.#store.setSearchOpen(false);
                this.#focusManager.restore();
                return true;
            case "toolForm":
                this.#store.clearToolForm();
                this.#focusManager.restore();
                return true;
            default:
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
}

function isSearchablePage(page: string): boolean {
    return page === "instances" || page === "config" || page === "audit" || page === "logs";
}
