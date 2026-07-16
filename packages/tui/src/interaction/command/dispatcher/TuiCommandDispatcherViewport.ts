import type { TuiUiIntent } from "../../../state/TuiInteractionState.js";
import type { TuiAppStore } from "../../../state/TuiAppStore.js";
import type { TuiInteractionProjection } from "../../TuiInteractionProjection.js";
import type { TuiFocusManager } from "../../focus/TuiFocusManager.js";
import type { TuiCommandDispatcherFocus } from "./TuiCommandDispatcherFocus.js";

export interface TuiCommandDispatcherViewportOptions {
    focus: TuiCommandDispatcherFocus;
    focusManager: TuiFocusManager;
    projection: TuiInteractionProjection;
    store: TuiAppStore;
}

export class TuiCommandDispatcherViewport {
    readonly #focus: TuiCommandDispatcherFocus;
    readonly #focusManager: TuiFocusManager;
    readonly #projection: TuiInteractionProjection;
    readonly #store: TuiAppStore;

    constructor(options: TuiCommandDispatcherViewportOptions) {
        this.#focus = options.focus;
        this.#focusManager = options.focusManager;
        this.#projection = options.projection;
        this.#store = options.store;
    }

    dispatch(intent: TuiUiIntent): boolean | undefined {
        switch (intent.type) {
            case "focus.move":
                return intent.direction === "next" || intent.direction === "previous"
                    ? this.#moveAcrossScopes(intent.direction)
                    : this.#moveWithinScope(intent.direction);
            case "screen.pageUp":
                this.#focus.pauseLogFollow();
                return this.#focus.scrollMainColumn(-Math.max(1, this.#focus.boxViewportRows() - 1));
            case "screen.pageDown":
                return this.#focus.scrollMainColumn(Math.max(1, this.#focus.boxViewportRows() - 1));
            case "screen.home":
                this.#focus.pauseLogFollow();
                return this.#focus.setMainColumnOffset(0);
            case "screen.end":
                return this.#focus.setMainColumnOffset(this.#focus.maxMainScrollOffset());
            case "screen.toggle":
                return this.#toggleCurrentBox();
            case "logs.toggleFollow":
                return this.#toggleLogsFollow();
            case "logs.clearBuffer":
                return this.#clearLogsBuffer();
            default:
                return undefined;
        }
    }

    cancelPassiveScope(): boolean {
        const scope = this.#store.getState().interaction.focusScope;
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
        this.#store.setFocusScope(cursor?.kind === "instance" ? "sidebarInstances" : "sidebarPages");
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
            const box = this.#projection.selectMainScreenModel(this.#store.getState()).boxes.find(
                (candidate) => candidate.id === boxId
            );
            this.#store.setSelectedDetailLine(key, box?.expandedLines[0]?.id);
        }
        this.#focus.ensureMainFocusVisible();
        this.#store.setScreenStatus(
            this.#store.getState().ui.selectedPage,
            expanded ? "Collapsed box." : "Expanded box."
        );
        return true;
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
            this.#focus.setMainColumnOffset(this.#focus.maxMainScrollOffset());
        } else {
            this.#store.setLogsPausedAtSeq(instance, state.logsByInstance[instance]?.at(-1)?.seq);
        }
        this.#store.setScreenStatus("logs", follow ? "Following new log entries." : "Log follow paused.");
        return true;
    }

    #clearLogsBuffer(): boolean {
        if (this.#store.getState().ui.selectedPage !== "logs") {
            return false;
        }
        this.#store.clearLogsBuffer();
        this.#store.setScreenStatus("logs", "Cleared local log buffer only.");
        return true;
    }

    #moveAcrossScopes(direction: "next" | "previous"): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        const hasBoxes = this.#projection.selectMainBoxIds(this.#store.getState()).length > 0;
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
            if (!hasBoxes) return false;
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

    #moveWithinScope(direction: "up" | "down" | "left" | "right"): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "textDetail") {
            return false;
        }
        if (scope === "approvalDetail" || scope === "denyConfirm") {
            return (direction === "up" || direction === "down") && this.#focusManager.move(direction);
        }
        if (scope === "boxDetail" || scope === "form" || scope === "wizard") {
            if (direction === "left" && scope === "boxDetail") {
                this.returnToSidebar();
                return true;
            }
            return (direction === "up" || direction === "down") && this.#focusManager.move(direction);
        }
        if ((scope === "sidebarPages" || scope === "sidebarInstances") && direction === "right") {
            if (this.#projection.selectMainBoxIds(this.#store.getState()).length === 0) return false;
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
}
