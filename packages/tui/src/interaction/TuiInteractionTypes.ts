import type { InstanceCreateSchema, JsonValue } from "@portable-devshell/shared";

import type { AuditPageState, FocusScope, PageId, SidebarCursor } from "../model/TuiUiTypes.js";

export type TuiEditorKind = "config" | "connector" | "create";

export interface TuiEditorState {
    cursor?: number;
    editing: boolean;
    error?: string;
    key: string;
    kind: TuiEditorKind;
    schema?: InstanceCreateSchema;
    step?: number;
    summary?: JsonValue;
}

export type FocusItem =
    | { kind: "page"; id: PageId }
    | { kind: "instance"; id: string }
    | { kind: "box"; id: string }
    | { boxId: string; kind: "line"; id: string }
    | { kind: "field"; id: string }
    | { kind: "button"; id: "save" | "cancel" | string }
    | { kind: "approvalAction"; id: "approve" | "deny" | "back" };

export type TuiMode = FocusScope;

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

export interface TuiTextDetailState {
    body: string;
    open: boolean;
    scrollOffset: number;
    title: string;
}

export interface TuiToolFormState {
    input: string;
    instance: string;
    open: boolean;
    toolName: string;
}

export interface TuiInteractionState {
    auditPage: AuditPageState;
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
    selectedConfirmButton: "cancel" | "confirm";
    selectedDetailLineIds: Record<string, string>;
    search: TuiSearchState;
    editor?: TuiEditorState;
    toolForm?: TuiToolFormState;
    textDetail: TuiTextDetailState;
    sidebarCursor?: SidebarCursor;
}

export type TuiUiIntent =
    | { type: "app.quit" }
    | { type: "app.requestQuit" }
    | { page: PageId; type: "page.select" }
    | { type: "page.reload" }
    | { index: number; type: "instance.selectIndex" }
    | { direction: "next" | "previous" | "up" | "down" | "left" | "right"; type: "focus.move" }
    | { type: "focus.activate" }
    | { type: "ui.cancel" }
    | { type: "ui.help" }
    | { type: "ui.redraw" }
    | { type: "search.open" }
    | { type: "search.submit" }
    | { text: string; type: "search.append" }
    | { type: "search.backspace" }
    | { instance: string; toolName: string; type: "toolForm.open" }
    | { text: string; type: "toolForm.append" }
    | { type: "toolForm.backspace" }
    | { type: "toolForm.submit" }
    | { type: "toolForm.cancel" }
    | { kind: TuiEditorKind; key: string; schema?: InstanceCreateSchema; type: "editor.open" }
    | { type: "editor.close" }
    | { text: string; type: "editor.append" }
    | { type: "editor.backspace" }
    | { direction: "left" | "right"; type: "editor.cursorMove" }
    | { type: "editor.save" }
    | { type: "editor.saveAndRestart" }
    | { type: "editor.reload" }
    | { type: "editor.reloadConfirmed" }
    | { type: "editor.validate" }
    | { direction: "next" | "previous"; type: "wizard.step" }
    | { type: "editor.discard" }
    | { type: "confirm.accept" }
    | { type: "confirm.cancel" }
    | { type: "screen.pageUp" }
    | { type: "screen.pageDown" }
    | { type: "screen.home" }
    | { type: "screen.end" }
    | { type: "screen.toggle" }
    | { body: string; title: string; type: "textDetail.open" }
    | { type: "textDetail.close" }
    | { delta: number; type: "textDetail.scroll" }
    | { type: "logs.toggleFollow" }
    | { type: "logs.clearBuffer" }
    | { body: string; cancelLabel?: string; confirmIntent: TuiUiIntent; confirmLabel?: string; title: string; type: "overlay.openConfirm" }
    | { type: "overlay.closeConfirm" }
    | { key: string; type: "ui.toggleExpanded" }
    | { focusScope: FocusScope; type: "focus.scope.set" }
    | { id?: string; type: "mainFocus.set" }
    | { button: "cancel" | "confirm"; type: "confirm.focus" }
    | { page: PageId; status: string; type: "screen.setStatus" }
    | { type: "screen.clearStatus" }
    | { instance: string; type: "instance.start" }
    | { instance: string; type: "instance.restart" }
    | { enabled: boolean; instance: string; type: "instance.setEnabled" }
    | { instance: string; type: "instance.stop" }
    | { instance: string; type: "instance.attachShell" }
    | { instance: string; type: "instance.delete" }
    | { approvalId: string; instance: string; type: "approval.open" }
    | { approvalId: string; decision: "approve" | "deny"; instance: string; type: "approval.decide" }
    | { approvalId: string; decision: "approve" | "deny"; type: "oauthApproval.decide" }
    | { type: "approval.back" }
    | { approvalId: string; instance: string; type: "approval.confirmDeny" };

export function focusItemKey(item: FocusItem): string {
    return item.kind === "line" ? `${item.kind}:${item.boxId}:${item.id}` : `${item.kind}:${item.id}`;
}

export function isSameFocusItem(left: FocusItem | undefined, right: FocusItem | undefined): boolean {
    if (left === undefined || right === undefined) {
        return left === right;
    }

    return left.kind === right.kind && left.id === right.id && (left.kind !== "line" || right.kind !== "line" || left.boxId === right.boxId);
}

export function createEmptyInteractionState(): TuiInteractionState {
    return {
        auditPage: {
            mode: "list"
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
        selectedDetailLineIds: {},
        search: {
            open: false
        },
        textDetail: { body: "", open: false, scrollOffset: 0, title: "" },
        sidebarCursor: undefined
    };
}
