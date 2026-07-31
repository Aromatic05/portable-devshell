import type { TuiUiIntent } from "../../../state/TuiInteractionState.js";
import type { TuiAppStore } from "../../../state/TuiAppStore.js";
import type { TuiPageId } from "../../../state/TuiUiState.js";
import type { TuiInteractionProjection } from "../../TuiInteractionProjection.js";
import type { TuiFocusManager } from "../../focus/TuiFocusManager.js";
import type { TuiCommandDispatcherFocus } from "./TuiCommandDispatcherFocus.js";
import { TuiCommandDispatcherOverlay } from "./TuiCommandDispatcherOverlay.js";
import { TuiCommandDispatcherViewport } from "./TuiCommandDispatcherViewport.js";
import { selectTuiOverviewInstanceName } from "../../../view/page/TuiOverviewPresentation.js";

export interface TuiCommandDispatcherNavigationOptions {
    dispatch?(intent: TuiUiIntent): Promise<boolean>;
    focus: TuiCommandDispatcherFocus;
    focusManager: TuiFocusManager;
    onContextMessage?(instance: string, ctxId: string, text: string): Promise<void>;
    onLogsReload(): Promise<void>;
    onPageReload(page: TuiPageId, instance: string | undefined): Promise<void>;
    onRedraw(): void;
    projection: TuiInteractionProjection;
    store: TuiAppStore;
}

export class TuiCommandDispatcherNavigation {
    readonly #focus: TuiCommandDispatcherFocus;
    readonly #onLogsReload: () => Promise<void>;
    readonly #onPageReload: TuiCommandDispatcherNavigationOptions["onPageReload"];
    readonly #onRedraw: () => void;
    readonly #projection: TuiInteractionProjection;
    readonly #overlay: TuiCommandDispatcherOverlay;
    readonly #store: TuiAppStore;
    readonly #viewport: TuiCommandDispatcherViewport;

    constructor(options: TuiCommandDispatcherNavigationOptions) {
        this.#focus = options.focus;
        this.#onLogsReload = options.onLogsReload;
        this.#onPageReload = options.onPageReload;
        this.#onRedraw = options.onRedraw;
        this.#projection = options.projection;
        this.#store = options.store;
        this.#overlay = new TuiCommandDispatcherOverlay({
            dispatch: options.dispatch,
            focus: options.focus,
            focusManager: options.focusManager,
            onContextMessage: options.onContextMessage,
            store: options.store
        });
        this.#viewport = new TuiCommandDispatcherViewport({
            focus: options.focus,
            focusManager: options.focusManager,
            projection: options.projection,
            store: options.store
        });
    }

    async dispatch(intent: TuiUiIntent): Promise<boolean | undefined> {
        switch (intent.type) {
            case "page.select":
                return await this.#selectPage(intent.page);
            case "instance.selectIndex":
                return this.#selectInstanceIndex(intent.index);
            case "page.reload":
                return await this.#reloadPage();
            case "ui.help":
                return await this.#selectPage("help");
            case "ui.redraw":
                this.#store.bumpRedrawNonce();
                this.#onRedraw();
                return true;
            case "focus.scope.set":
                this.#store.setFocusScope(intent.focusScope);
                return true;
            case "mainFocus.set":
                this.#store.setMainFocusId(intent.id);
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
            default:
                break;
        }

        const overlayResult = await this.#overlay.dispatch(intent);
        return overlayResult ?? this.#viewport.dispatch(intent);
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
        return true;
    }

    cancelPassiveScope(): boolean {
        if (this.#overlay.cancelPassiveScope()) {
            return true;
        }
        if (this.#store.popRoute()) {
            this.#focus.syncMainFocus();
            return true;
        }
        return this.#viewport.cancelPassiveScope();
    }

    openFocusedRoute(): boolean {
        const state = this.#store.getState();
        if (state.ui.selectedPage === "overview") {
            const instance = selectTuiOverviewInstanceName(state.ui.mainFocusId);
            if (instance === undefined) {
                this.#store.setScreenStatus("overview", "Select an instance row first.");
                return false;
            }
            this.#store.setSelectedInstance(instance);
            this.#store.setSelectedPage("instances");
            this.#store.setMainFocusId(`instance:${instance}`);
            this.#focus.syncMainFocus();
            return true;
        }
        const box = this.#projection.selectMainScreenModel(state).boxes.find((candidate) => candidate.id === state.ui.mainFocusId);
        if (box?.primaryAction?.kind !== "navigate" || box.disabled === true) {
            this.#store.setScreenStatus(state.ui.selectedPage, "This box has no detail page.");
            return false;
        }
        this.#store.pushRoute(box.primaryAction.route);
        this.#focus.syncMainFocus();
        return true;
    }

    returnToSidebar(): void {
        this.#viewport.returnToSidebar();
    }

    async #selectPage(page: TuiPageId): Promise<boolean> {
        this.#store.setSelectedPage(page);
        this.#store.setSidebarCursor({ id: page, kind: "page" });
        this.#focus.syncMainFocus();
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
            if (state.ui.selectedPage === "logs" && state.ui.selectedInstance !== undefined) {
                await this.#onLogsReload();
            } else {
                await this.#onPageReload(state.ui.selectedPage, state.ui.selectedInstance);
            }
            this.#store.setScreenStatus(state.ui.selectedPage, "Page reloaded.");
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
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
