import type { TuiPanel } from "../store/TuiReducers.js";

export type TuiMode = "normal" | "edit" | "actionMenu" | "confirm" | "search";

export type FocusItem =
    | { kind: "panel"; id: string }
    | { kind: "listItem"; id: string }
    | { kind: "card"; id: string }
    | { kind: "field"; id: string }
    | { kind: "button"; id: "save" | "cancel" | string }
    | { kind: "action"; id: string };

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
    query: string;
}

export interface TuiLogsViewportState {
    follow: boolean;
    topIndex: number;
}

export interface TuiInteractionState {
    actionMenu: TuiActionMenuState;
    confirmDialog: TuiConfirmDialogState;
    currentFocus?: FocusItem;
    dirty: boolean;
    expandedByKey: Record<string, boolean>;
    logsViewport: TuiLogsViewportState;
    mode: TuiMode;
    redrawNonce: number;
    screenStatusByPanel: Partial<Record<TuiPanel, string>>;
    screenToggleByPanel: Partial<Record<TuiPanel, boolean>>;
    search: TuiSearchState;
}

export type TuiUiIntent =
    | { type: "app.quit" }
    | { type: "app.requestQuit" }
    | { panel: TuiPanel; type: "panel.activate" }
    | { direction: "next" | "previous"; type: "panel.cycle" }
    | { direction: "next" | "previous" | "up" | "down" | "left" | "right"; type: "focus.move" }
    | { item: FocusItem; type: "focus.set" }
    | { type: "focus.activate" }
    | { item: FocusItem; type: "focus.activateItem" }
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
    | { value: boolean; type: "edit.setDirty" }
    | { mode: TuiMode; type: "mode.set" }
    | { items: TuiActionMenuItem[]; title: string; type: "overlay.openActionMenu" }
    | { body: string; cancelLabel?: string; confirmIntent: TuiUiIntent; confirmLabel?: string; title: string; type: "overlay.openConfirm" }
    | { type: "overlay.closeActionMenu" }
    | { type: "overlay.closeConfirm" }
    | { key: string; type: "ui.toggleExpanded" }
    | { panel: TuiPanel; status: string; type: "screen.setStatus" }
    | { panel: TuiPanel; value: boolean; type: "screen.setToggle" }
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
        expandedByKey: {},
        logsViewport: {
            follow: true,
            topIndex: 0
        },
        mode: "normal",
        redrawNonce: 0,
        screenStatusByPanel: {},
        screenToggleByPanel: {},
        search: {
            open: false,
            query: ""
        }
    };
}
