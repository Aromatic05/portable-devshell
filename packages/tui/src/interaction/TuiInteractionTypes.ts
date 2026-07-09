import type { FocusScope, PageId, SidebarCursor } from "../model/TuiUiTypes.js";

export type FocusItem =
    | { kind: "page"; id: PageId }
    | { kind: "instance"; id: string }
    | { kind: "box"; id: string }
    | { kind: "field"; id: string }
    | { kind: "button"; id: "save" | "cancel" | string }
    | { kind: "action"; id: string };

export type TuiMode = FocusScope;

export interface TuiActionMenuItem {
    id: string;
    label: string;
    intent: TuiUiIntent;
}

export interface TuiActionMenuState {
    items: TuiActionMenuItem[];
    open: boolean;
    selectedIndex: number;
    title: string;
}

export interface TuiConfirmDialogState {
    body: string;
    cancelLabel: string;
    confirmIntent: TuiUiIntent;
    confirmLabel: string;
    open: boolean;
    title: string;
}

export interface TuiSearchState {
    open: boolean;
}

export interface TuiInteractionState {
    actionMenu: TuiActionMenuState;
    confirmDialog: TuiConfirmDialogState;
    dirty: boolean;
    focusScope: FocusScope;
    redrawNonce: number;
    restoreStack: Array<{
        focusScope: FocusScope;
        mainFocusId?: string;
        sidebarFocus: "pages" | "instances";
    }>;
    screenStatusByPage: Partial<Record<PageId, string>>;
    selectedActionId?: string;
    selectedConfirmButton: "cancel" | "confirm";
    search: TuiSearchState;
    sidebarCursor?: SidebarCursor;
}

export type TuiUiIntent =
    | { type: "app.quit" }
    | { type: "app.requestQuit" }
    | { page: PageId; type: "page.select" }
    | { direction: "next" | "previous" | "up" | "down" | "left" | "right"; type: "focus.move" }
    | { type: "focus.activate" }
    | { type: "ui.cancel" }
    | { type: "ui.help" }
    | { type: "ui.redraw" }
    | { type: "search.open" }
    | { type: "search.submit" }
    | { text: string; type: "search.append" }
    | { type: "search.backspace" }
    | { type: "actionMenu.open" }
    | { direction: "up" | "down"; type: "actionMenu.move" }
    | { type: "actionMenu.submit" }
    | { type: "confirm.accept" }
    | { type: "confirm.cancel" }
    | { type: "screen.pageUp" }
    | { type: "screen.pageDown" }
    | { type: "screen.home" }
    | { type: "screen.end" }
    | { type: "screen.toggle" }
    | { type: "logs.reload" }
    | { type: "logs.toggleFollow" }
    | { type: "logs.clearBuffer" }
    | { items: TuiActionMenuItem[]; title: string; type: "overlay.openActionMenu" }
    | { body: string; cancelLabel?: string; confirmIntent: TuiUiIntent; confirmLabel?: string; title: string; type: "overlay.openConfirm" }
    | { type: "overlay.closeActionMenu" }
    | { type: "overlay.closeConfirm" }
    | { key: string; type: "ui.toggleExpanded" }
    | { focusScope: FocusScope; type: "focus.scope.set" }
    | { id?: string; type: "mainFocus.set" }
    | { button: "cancel" | "confirm"; type: "confirm.focus" }
    | { page: PageId; status: string; type: "screen.setStatus" }
    | { type: "screen.clearStatus" };

export function focusItemKey(item: FocusItem): string {
    return `${item.kind}:${item.id}`;
}

export function isSameFocusItem(left: FocusItem | undefined, right: FocusItem | undefined): boolean {
    if (left === undefined || right === undefined) {
        return left === right;
    }

    return left.kind === right.kind && left.id === right.id;
}

export function createEmptyInteractionState(): TuiInteractionState {
    return {
        actionMenu: {
            items: [],
            open: false,
            selectedIndex: 0,
            title: ""
        },
        confirmDialog: {
            body: "",
            cancelLabel: "Cancel",
            confirmIntent: { type: "ui.cancel" },
            confirmLabel: "Confirm",
            open: false,
            title: ""
        },
        dirty: false,
        focusScope: "sidebarPages",
        redrawNonce: 0,
        restoreStack: [],
        screenStatusByPage: {},
        selectedConfirmButton: "cancel",
        search: {
            open: false
        },
        sidebarCursor: undefined
    };
}
