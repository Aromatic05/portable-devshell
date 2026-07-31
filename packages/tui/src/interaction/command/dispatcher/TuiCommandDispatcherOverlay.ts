import type { TuiUiIntent } from "../../../state/TuiInteractionState.js";
import type { TuiAppStore } from "../../../state/TuiAppStore.js";
import {
    topTuiOverlay,
    type TuiConfirmationOverlay,
    type TuiMessageComposerOverlay,
    type TuiTextDetailOverlay,
} from "../../../state/overlay/TuiOverlay.js";
import { isTuiSearchablePage } from "../../../state/TuiPageCatalog.js";
import { currentTuiRoute } from "../../../state/route/TuiRouteState.js";
import type { TuiFocusManager } from "../../focus/TuiFocusManager.js";
import type { TuiCommandDispatcherFocus } from "./TuiCommandDispatcherFocus.js";

export interface TuiCommandDispatcherOverlayOptions {
    dispatch?(intent: TuiUiIntent): Promise<boolean>;
    focus: TuiCommandDispatcherFocus;
    focusManager: TuiFocusManager;
    onContextMessage?(
        instance: string,
        ctxId: string,
        text: string,
    ): Promise<void>;
    store: TuiAppStore;
}

export class TuiCommandDispatcherOverlay {
    readonly #dispatch?: (intent: TuiUiIntent) => Promise<boolean>;
    readonly #focus: TuiCommandDispatcherFocus;
    readonly #focusManager: TuiFocusManager;
    readonly #onContextMessage?: TuiCommandDispatcherOverlayOptions["onContextMessage"];
    readonly #store: TuiAppStore;

    constructor(options: TuiCommandDispatcherOverlayOptions) {
        this.#dispatch = options.dispatch;
        this.#focus = options.focus;
        this.#focusManager = options.focusManager;
        this.#onContextMessage = options.onContextMessage;
        this.#store = options.store;
    }

    async dispatch(intent: TuiUiIntent): Promise<boolean | undefined> {
        switch (intent.type) {
            case "search.open":
                return this.#openSearch();
            case "search.append":
                return this.#updateSearch(
                    (current) => `${current}${intent.text}`,
                );
            case "search.backspace":
                return this.#updateSearch((current) => current.slice(0, -1));
            case "search.submit":
                return this.#closeOverlay("search");
            case "confirm.focus":
                return this.#focusConfirmation(intent.button);
            case "confirm.accept":
                return await this.#acceptConfirm();
            case "confirm.cancel":
            case "overlay.closeConfirm":
                return this.#closeOverlay("confirmation");
            case "overlay.openConfirm":
                this.#openConfirmation(intent);
                return true;
            case "textDetail.open":
                this.#openTextDetail(intent);
                return true;
            case "textDetail.close":
                return this.#closeOverlay("text-detail");
            case "textDetail.scroll":
                return this.#scrollTextDetail(intent.delta);
            case "messageComposer.open":
                this.#openMessageComposer(intent.instance, intent.ctxId);
                return true;
            case "messageComposer.openCurrent":
                return this.#openCurrentMessageComposer();
            case "messageComposer.append":
                return this.#updateMessageComposer((overlay) => ({
                    ...overlay,
                    draft: `${overlay.draft}${intent.text}`,
                    error: undefined,
                }));
            case "messageComposer.backspace":
                return this.#updateMessageComposer((overlay) => ({
                    ...overlay,
                    draft: overlay.draft.slice(0, -1),
                    error: undefined,
                }));
            case "messageComposer.focus":
                return this.#moveMessageComposerFocus(intent.direction);
            case "messageComposer.cancel":
                return this.#closeOverlay("message-composer");
            case "messageComposer.submit":
                return await this.#submitMessageComposer(false);
            case "messageComposer.forceSubmit":
                return await this.#submitMessageComposer(true);
            default:
                return undefined;
        }
    }

    cancelPassiveScope(): boolean {
        const overlay = topTuiOverlay(
            this.#store.getState().interaction.overlays,
        );
        if (overlay === undefined) return false;
        return this.#closeOverlay(overlay.kind);
    }

    #openSearch(): boolean {
        const page = this.#store.getState().ui.selectedPage;
        if (!isTuiSearchablePage(page)) return false;
        this.#focusManager.pushRestore("search");
        this.#store.pushOverlay({ kind: "search", page });
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

    #openConfirmation(
        intent: Extract<TuiUiIntent, { type: "overlay.openConfirm" }>,
    ): void {
        this.#focusManager.pushRestore("confirm");
        this.#store.pushOverlay({
            body: intent.body,
            cancelLabel: intent.cancelLabel ?? "Cancel",
            confirmIntent: intent.confirmIntent,
            confirmLabel: intent.confirmLabel ?? "Confirm",
            kind: "confirmation",
            selectedAction: "cancel",
            title: intent.title,
        });
        this.#store.setFocusScope("confirm");
    }

    #focusConfirmation(button: "cancel" | "confirm"): boolean {
        const overlay = topTuiOverlay(
            this.#store.getState().interaction.overlays,
        );
        if (overlay?.kind !== "confirmation") return false;
        this.#store.replaceTopOverlay({ ...overlay, selectedAction: button });
        return true;
    }

    async #acceptConfirm(): Promise<boolean> {
        const overlay = topTuiOverlay(
            this.#store.getState().interaction.overlays,
        );
        if (overlay?.kind !== "confirmation") return false;
        if (overlay.selectedAction === "cancel")
            return this.#closeOverlay("confirmation");
        const confirmIntent = overlay.confirmIntent;
        this.#closeOverlay("confirmation");
        return this.#dispatch === undefined
            ? false
            : await this.#dispatch(confirmIntent);
    }

    #openTextDetail(
        intent: Extract<TuiUiIntent, { type: "textDetail.open" }>,
    ): void {
        this.#focusManager.pushRestore("textDetail");
        this.#store.pushOverlay({
            body: intent.body,
            image: intent.image,
            kind: "text-detail",
            scrollOffset: 0,
            title: intent.title,
        });
        this.#store.setFocusScope("textDetail");
    }

    #scrollTextDetail(delta: number): boolean {
        const overlay = topTuiOverlay(
            this.#store.getState().interaction.overlays,
        );
        if (overlay?.kind !== "text-detail") return false;
        this.#store.replaceTopOverlay({
            ...overlay,
            scrollOffset: Math.max(0, overlay.scrollOffset + delta),
        });
        return true;
    }

    #openCurrentMessageComposer(): boolean {
        const state = this.#store.getState();
        const route = currentTuiRoute(state);
        if (
            state.ui.selectedInstance === undefined ||
            route.page !== "audit" ||
            route.view === "contexts" ||
            route.scope !== "context"
        ) {
            this.#store.setScreenStatus(
                state.ui.selectedPage,
                "Open an Audit Context before sending a message.",
            );
            return false;
        }
        this.#openMessageComposer(state.ui.selectedInstance, route.ctxId);
        return true;
    }

    #openMessageComposer(instance: string, ctxId: string): void {
        this.#focusManager.pushRestore("messageComposer");
        this.#store.pushOverlay({
            ctxId,
            draft: "",
            instance,
            kind: "message-composer",
            selectedAction: "editor",
            submitting: false,
        });
        this.#store.setFocusScope("messageComposer");
    }

    #updateMessageComposer(
        update: (
            overlay: TuiMessageComposerOverlay,
        ) => TuiMessageComposerOverlay,
    ): boolean {
        const overlay = topTuiOverlay(
            this.#store.getState().interaction.overlays,
        );
        if (overlay?.kind !== "message-composer" || overlay.submitting)
            return false;
        this.#store.replaceTopOverlay(update(overlay));
        return true;
    }

    #moveMessageComposerFocus(direction: "next" | "previous"): boolean {
        const order: readonly TuiMessageComposerOverlay["selectedAction"][] = [
            "editor",
            "send",
            "cancel",
        ];
        return this.#updateMessageComposer((overlay) => {
            const current = order.indexOf(overlay.selectedAction);
            const delta = direction === "next" ? 1 : -1;
            return {
                ...overlay,
                selectedAction:
                    order[(current + delta + order.length) % order.length]!,
            };
        });
    }

    async #submitMessageComposer(force: boolean): Promise<boolean> {
        const overlay = topTuiOverlay(
            this.#store.getState().interaction.overlays,
        );
        if (overlay?.kind !== "message-composer" || overlay.submitting)
            return false;
        if (overlay.selectedAction === "cancel")
            return this.#closeOverlay("message-composer");
        if (overlay.selectedAction === "editor" && !force) {
            this.#store.replaceTopOverlay({
                ...overlay,
                draft: `${overlay.draft}\n`,
            });
            return true;
        }
        const text = overlay.draft.trim();
        if (text.length === 0) {
            this.#store.replaceTopOverlay({
                ...overlay,
                error: "Message cannot be empty.",
            });
            return false;
        }
        if (this.#onContextMessage === undefined) {
            this.#store.replaceTopOverlay({
                ...overlay,
                error: "Context message service is unavailable.",
            });
            return false;
        }
        this.#store.replaceTopOverlay({
            ...overlay,
            error: undefined,
            submitting: true,
        });
        try {
            await this.#onContextMessage(overlay.instance, overlay.ctxId, text);
            return this.#closeOverlay("message-composer");
        } catch (error) {
            const current = topTuiOverlay(
                this.#store.getState().interaction.overlays,
            );
            if (current?.kind === "message-composer") {
                this.#store.replaceTopOverlay({
                    ...current,
                    error: readErrorMessage(error),
                    submitting: false,
                });
            }
            return false;
        }
    }

    #closeOverlay(
        expectedKind:
            | TuiConfirmationOverlay["kind"]
            | TuiTextDetailOverlay["kind"]
            | "search"
            | "tool-form"
            | "message-composer"
            | "approval",
    ): boolean {
        const overlay = topTuiOverlay(
            this.#store.getState().interaction.overlays,
        );
        if (overlay?.kind !== expectedKind) return false;
        this.#store.popOverlay();
        this.#focusManager.restore();
        return true;
    }
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
