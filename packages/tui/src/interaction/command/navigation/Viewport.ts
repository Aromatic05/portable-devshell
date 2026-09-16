import type { TuiUiIntent } from "../../../state/Interaction.js";
import type { TuiAppStore } from "../../../state/store/App.js";
import type { TuiInteractionProjection } from "../../Projection.js";
import type { TuiFocusManager } from "../../focus/Manager.js";
import type { TuiCommandDispatcherFocus } from "./Focus.js";

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
                return intent.direction === "next" ||
                    intent.direction === "previous"
                    ? this.#moveAcrossScopes(intent.direction)
                    : this.#moveWithinScope(intent.direction);
            case "screen.pageUp":
                return this.#focus.scrollMainColumn(
                    -Math.max(1, this.#focus.boxViewportRows() - 1),
                );
            case "screen.pageDown":
                return this.#focus.scrollMainColumn(
                    Math.max(1, this.#focus.boxViewportRows() - 1),
                );
            case "screen.scroll":
                return this.#focus.scrollMainColumn(intent.delta);
            case "screen.home":
                return this.#focus.setMainColumnOffset(0);
            case "screen.end":
                return this.#focus.setMainColumnOffset(
                    this.#focus.maxMainScrollOffset(),
                );
            case "screen.toggle":
                return this.#toggleCurrentBox();
            default:
                return undefined;
        }
    }

    cancelPassiveScope(): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        if (scope === "terminal") {
            this.returnToSidebar();
            return true;
        }
        if (scope === "boxDetail") {
            this.#store.setFocusScope("mainBoxes");
            return true;
        }
        if (scope === "mainBoxes" || scope === "sidebarInstances") {
            return false;
        }
        return false;
    }

    returnToSidebar(): void {
        const cursor = this.#store.getState().interaction.sidebarCursor;
        this.#store.setFocusScope(
            cursor?.kind === "instance" ? "sidebarInstances" : "sidebarContext",
        );
    }

    #toggleCurrentBox(): boolean {
        if (this.#store.getState().interaction.focusScope !== "mainBoxes") {
            return false;
        }
        const boxId = this.#store.getState().ui.mainFocusId;
        if (boxId === undefined) {
            return false;
        }
        const box = this.#projection
            .selectMainScreenModel(this.#store.getState())
            .boxes.find((candidate) => candidate.id === boxId);
        if (box?.expandable !== true) {
            this.#store.setScreenStatus(
                this.#store.getState().ui.selectedPage,
                "This box has no expandable details.",
            );
            return false;
        }
        const key = box.expandedKey;
        const expanded = this.#store.getState().ui.expandedBoxes[key] === true;
        this.#store.toggleExpanded(key);
        this.#focus.ensureMainFocusVisible();
        this.#store.setScreenStatus(
            this.#store.getState().ui.selectedPage,
            expanded ? "Collapsed box." : "Expanded box.",
        );
        return true;
    }

    #moveAcrossScopes(direction: "next" | "previous"): boolean {
        const scope = this.#store.getState().interaction.focusScope;
        const hasBoxes =
            this.#projection.selectMainBoxIds(this.#store.getState()).length >
            0;
        if (
            scope === "confirm" ||
            scope === "approvalDetail" ||
            scope === "denyConfirm" ||
            scope === "form" ||
            scope === "wizard"
        ) {
            const moved = this.#focusManager.move(direction);
            if (moved && (scope === "form" || scope === "wizard")) {
                this.#focus.ensureMainFocusVisible();
            }
            return moved;
        }
        if (scope === "sidebarContext" || scope === "sidebarInstances") {
            if (this.#store.getState().ui.selectedPage === "terminal") {
                this.#store.setFocusScope("terminal");
                return true;
            }
            if (!hasBoxes) return false;
            this.#store.setFocusScope("mainBoxes");
            this.#focus.syncMainFocus();
            return true;
        }
        if (scope === "terminal") {
            this.returnToSidebar();
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
        if (scope === "terminal") {
            if (direction === "left") {
                this.returnToSidebar();
                return true;
            }
            return false;
        }
        if (scope === "textDetail") {
            return false;
        }
        if (scope === "approvalDetail" || scope === "denyConfirm") {
            return (
                (direction === "up" || direction === "down") &&
                this.#focusManager.move(direction)
            );
        }
        if (scope === "boxDetail" || scope === "form" || scope === "wizard") {
            if (direction === "left" && scope === "boxDetail") {
                this.returnToSidebar();
                return true;
            }
            const moved =
                (direction === "up" || direction === "down") &&
                this.#focusManager.move(direction);
            if (moved && (scope === "form" || scope === "wizard")) {
                this.#focus.ensureMainFocusVisible();
            }
            return moved;
        }
        if (
            (scope === "sidebarContext" || scope === "sidebarInstances") &&
            direction === "right"
        ) {
            if (this.#store.getState().ui.selectedPage === "terminal") {
                this.#store.setFocusScope("terminal");
                return true;
            }
            if (
                this.#projection.selectMainBoxIds(this.#store.getState())
                    .length === 0
            )
                return false;
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
