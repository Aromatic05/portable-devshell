import type {
    ArtifactViewImageResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
} from "@portable-devshell/shared";

import type { TuiOverlay } from "./overlay/TuiOverlay.js";
import type {
    TuiFocusScope,
    TuiPageId,
    TuiSidebarCursor,
} from "./TuiUiState.js";

export type TuiEditorKind = "comment" | "config" | "connector" | "create";

export interface TuiEditorState {
    cursor?: number;
    editing: boolean;
    error?: string;
    key: string;
    kind: TuiEditorKind;
    schema?: InstanceCreateSchema;
    step?: number;
    summary?: InstanceCreateSummary;
}

export type TuiMode = TuiFocusScope;

export interface TuiInteractionState {
    dirty: boolean;
    editor?: TuiEditorState;
    focusScope: TuiFocusScope;
    overlays: readonly TuiOverlay[];
    redrawNonce: number;
    screenStatusByPage: Partial<Record<TuiPageId, string>>;
    selectedDetailLineIds: Record<string, string>;
    sidebarCursor?: TuiSidebarCursor;
}

export type TuiUiIntent =
    | { type: "app.quit" }
    | { type: "app.requestQuit" }
    | { page: TuiPageId; type: "page.select" }
    | { type: "page.reload" }
    | { type: "control.restart" }
    | { index: number; type: "instance.selectIndex" }
    | {
          direction: "next" | "previous" | "up" | "down" | "left" | "right";
          type: "focus.move";
      }
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
    | {
          kind: TuiEditorKind;
          key: string;
          schema?: InstanceCreateSchema;
          type: "editor.open";
      }
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
    | {
          body: string;
          image?: ArtifactViewImageResult;
          title: string;
          type: "textDetail.open";
      }
    | { type: "textDetail.close" }
    | { delta: number; type: "textDetail.scroll" }
    | { type: "logs.toggleFollow" }
    | { type: "logs.clearBuffer" }
    | {
          body: string;
          cancelLabel?: string;
          confirmIntent: TuiUiIntent;
          confirmLabel?: string;
          title: string;
          type: "overlay.openConfirm";
      }
    | { type: "overlay.closeConfirm" }
    | { key: string; type: "ui.toggleExpanded" }
    | { focusScope: TuiFocusScope; type: "focus.scope.set" }
    | { id?: string; type: "mainFocus.set" }
    | { button: "cancel" | "confirm"; type: "confirm.focus" }
    | { page: TuiPageId; status: string; type: "screen.setStatus" }
    | { type: "screen.clearStatus" }
    | { instance: string; type: "instance.start" }
    | { instance: string; type: "instance.restart" }
    | { enabled: boolean; instance: string; type: "instance.setEnabled" }
    | { instance: string; type: "instance.stop" }
    | { instance: string; type: "instance.openTerminal" }
    | { type: "terminal.requestKill" }
    | { instance: string; type: "terminal.kill" }
    | { instance: string; type: "instance.delete" }
    | { instance: string; taskId: string; type: "todo.delete" }
    | { ctxId: string; instance: string; type: "context.disable" }
    | { ctxId: string; instance: string; type: "context.renew" }
    | { shareId: string; type: "artifact.revokeShare" }
    | { transferId: string; type: "artifact.cancelTransfer" }
    | { approvalId: string; instance: string; type: "approval.open" }
    | { type: "contextConversation.openCurrent" }
    | { type: "contextConversation.edit" }
    | { text: string; type: "contextConversation.append" }
    | { type: "contextConversation.backspace" }
    | { direction: "left" | "right"; type: "contextConversation.cursorMove" }
    | { type: "contextConversation.submit" }
    | {
          approvalId: string;
          decision: "approve" | "deny";
          instance: string;
          type: "approval.decide";
      }
    | {
          approvalId: string;
          decision: "approve" | "deny";
          type: "oauthApproval.decide";
      }
    | { type: "approval.back" }
    | { approvalId: string; instance: string; type: "approval.confirmDeny" };

export function createEmptyInteractionState(): TuiInteractionState {
    return {
        dirty: false,
        focusScope: "sidebarPages",
        overlays: [],
        redrawNonce: 0,
        screenStatusByPage: {},
        selectedDetailLineIds: {},
        sidebarCursor: undefined,
    };
}
