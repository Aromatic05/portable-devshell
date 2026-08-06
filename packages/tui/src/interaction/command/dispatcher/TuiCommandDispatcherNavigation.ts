import type { TuiUiIntent } from "../../../state/TuiInteractionState.js";
import type { TuiAppStore } from "../../../state/TuiAppStore.js";
import type { TuiPageId } from "../../../state/TuiUiState.js";
import type { TuiInteractionProjection } from "../../TuiInteractionProjection.js";
import type { TuiFocusManager } from "../../focus/TuiFocusManager.js";
import type { TuiCommandDispatcherFocus } from "./TuiCommandDispatcherFocus.js";
import { TuiCommandDispatcherOverlay } from "./TuiCommandDispatcherOverlay.js";
import { TuiCommandDispatcherViewport } from "./TuiCommandDispatcherViewport.js";
import { selectTuiOverviewInstanceName } from "../../../view/page/TuiOverviewPresentation.js";
import { topTuiOverlay } from "../../../state/overlay/TuiOverlay.js";
import { currentTuiRoute } from "../../../state/route/TuiRouteState.js";
import {
    isLatestObservedContext,
    latestObservedContextId,
} from "../../../state/audit/TuiAuditContextActivity.js";

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
    readonly #onContextMessage?: TuiCommandDispatcherNavigationOptions["onContextMessage"];
    readonly #onLogsReload: () => Promise<void>;
    readonly #onPageReload: TuiCommandDispatcherNavigationOptions["onPageReload"];
    readonly #onRedraw: () => void;
    readonly #projection: TuiInteractionProjection;
    readonly #overlay: TuiCommandDispatcherOverlay;
    readonly #store: TuiAppStore;
    readonly #viewport: TuiCommandDispatcherViewport;

    constructor(options: TuiCommandDispatcherNavigationOptions) {
        this.#focus = options.focus;
        this.#onContextMessage = options.onContextMessage;
        this.#onLogsReload = options.onLogsReload;
        this.#onPageReload = options.onPageReload;
        this.#onRedraw = options.onRedraw;
        this.#projection = options.projection;
        this.#store = options.store;
        this.#overlay = new TuiCommandDispatcherOverlay({
            dispatch: options.dispatch,
            focus: options.focus,
            focusManager: options.focusManager,
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
            case "contextConversation.openCurrent":
                return this.#openContextConversation();
            case "contextConversation.edit":
                return this.#startContextConversationEditing();
            case "contextConversation.append":
                return this.#editContextConversationDraft(intent.text, false);
            case "contextConversation.backspace":
                return this.#editContextConversationDraft("", true);
            case "contextConversation.cursorMove":
                return this.#moveContextConversationCursor(intent.direction);
            case "contextConversation.submit":
                return await this.#submitContextConversation();
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
        if (topTuiOverlay(this.#store.getState().interaction.overlays) !== undefined) {
            return this.#overlay.cancelPassiveScope();
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

    #openContextConversation(): boolean {
        const state = this.#store.getState();
        const route = currentTuiRoute(state);
        const instance = state.ui.selectedInstance;
        if (
            instance === undefined ||
            route.page !== "audit" ||
            route.view !== "context" ||
            route.scope !== "context"
        ) {
            return false;
        }
        this.#store.pushRoute({
            ctxId: route.ctxId,
            page: "audit",
            scope: "context",
            view: "conversation",
        });
        const key = contextConversationDraftKey(instance, route.ctxId);
        if (typeof this.#store.getState().ui.formDrafts[key] !== "string") {
            this.#store.setFormDraft(key, "", false);
        }
        this.#store.setMainFocusId("conversation-composer");
        this.#store.setFocusScope("mainBoxes");
        return true;
    }

    #startContextConversationEditing(): boolean {
        const target = this.#contextConversationTarget();
        if (target === undefined) return false;
        const draft = readContextConversationDraft(this.#store.getState(), target.instance, target.ctxId);
        this.#store.setEditor({
            cursor: draft.length,
            editing: true,
            key: contextConversationDraftKey(target.instance, target.ctxId),
            kind: "comment",
        });
        this.#store.setFocusScope("contextConversation");
        return true;
    }

    #editContextConversationDraft(input: string, backspace: boolean): boolean {
        const target = this.#contextConversationTarget();
        const editor = this.#store.getState().interaction.editor;
        if (target === undefined || editor?.kind !== "comment" || editor.editing !== true) return false;
        const draft = readContextConversationDraft(this.#store.getState(), target.instance, target.ctxId);
        const cursor = Math.min(Math.max(editor.cursor ?? draft.length, 0), draft.length);
        const next = backspace
            ? `${draft.slice(0, Math.max(0, cursor - 1))}${draft.slice(cursor)}`
            : `${draft.slice(0, cursor)}${input}${draft.slice(cursor)}`;
        this.#store.setFormDraft(
            contextConversationDraftKey(target.instance, target.ctxId),
            next,
            true,
        );
        this.#store.setEditor({
            ...editor,
            cursor: backspace ? Math.max(0, cursor - 1) : cursor + input.length,
        });
        this.#store.setScreenStatus("audit", undefined);
        return true;
    }

    #moveContextConversationCursor(direction: "left" | "right"): boolean {
        const target = this.#contextConversationTarget();
        const editor = this.#store.getState().interaction.editor;
        if (target === undefined || editor?.kind !== "comment" || editor.editing !== true) return false;
        const draft = readContextConversationDraft(this.#store.getState(), target.instance, target.ctxId);
        const cursor = Math.min(Math.max(editor.cursor ?? draft.length, 0), draft.length);
        this.#store.setEditor({
            ...editor,
            cursor: direction === "left" ? Math.max(0, cursor - 1) : Math.min(draft.length, cursor + 1),
        });
        return true;
    }

    async #submitContextConversation(): Promise<boolean> {
        const target = this.#contextConversationTarget();
        if (target === undefined) return false;
        const state = this.#store.getState();
        if (!isLatestObservedContext(state, target.instance, target.ctxId)) {
            const latest = latestObservedContextId(state, target.instance);
            this.#store.setScreenStatus(
                "audit",
                `Comment not queued: this context is no longer the latest observed context${latest === undefined ? "." : `; open ${latest}.`}`,
            );
            return false;
        }
        const text = readContextConversationDraft(
            state,
            target.instance,
            target.ctxId,
        ).trim();
        if (text.length === 0) {
            this.#store.setScreenStatus("audit", "Comment cannot be empty.");
            return false;
        }
        if (this.#onContextMessage === undefined) {
            this.#store.setScreenStatus("audit", "Context Comment service is unavailable.");
            return false;
        }
        try {
            await this.#onContextMessage(target.instance, target.ctxId, text);
            this.#store.setFormDraft(
                contextConversationDraftKey(target.instance, target.ctxId),
                "",
                false,
            );
            this.#store.setEditor({
                cursor: 0,
                editing: true,
                key: contextConversationDraftKey(target.instance, target.ctxId),
                kind: "comment",
            });
            this.#store.setScreenStatus("audit", "Comment queued.");
            this.#store.setFocusScope("contextConversation");
            return true;
        } catch (error) {
            this.#store.setScreenStatus("audit", `Comment failed: ${readErrorMessage(error)}`);
            return false;
        }
    }

    #contextConversationTarget(): { ctxId: string; instance: string } | undefined {
        const state = this.#store.getState();
        const route = currentTuiRoute(state);
        return state.ui.selectedInstance !== undefined &&
            route.page === "audit" &&
            route.view === "conversation" &&
            route.scope === "context"
            ? { ctxId: route.ctxId, instance: state.ui.selectedInstance }
            : undefined;
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


export function contextConversationDraftKey(instance: string, ctxId: string): string {
    return `contextConversation:${instance}:${ctxId}`;
}

export function readContextConversationDraft(
    state: import("../../../state/reducer/TuiStoreModel.js").TuiAppState,
    instance: string,
    ctxId: string,
): string {
    const value = state.ui.formDrafts[contextConversationDraftKey(instance, ctxId)];
    return typeof value === "string" ? value : "";
}
