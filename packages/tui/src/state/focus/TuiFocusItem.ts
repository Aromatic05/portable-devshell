import type { TuiPageId } from "../TuiUiState.js";

export type TuiFocusItem =
    | { kind: "page"; id: TuiPageId }
    | { kind: "instance"; id: string }
    | { kind: "box"; id: string }
    | { boxId: string; kind: "line"; id: string }
    | { kind: "field"; id: string }
    | { kind: "button"; id: "save" | "cancel" | string }
    | { kind: "approvalAction"; id: "approve" | "deny" | "back" | "input" };


export function tuiFocusItemKey(item: TuiFocusItem): string {
    return item.kind === "line" ? `${item.kind}:${item.boxId}:${item.id}` : `${item.kind}:${item.id}`;
}

export function isSameTuiFocusItem(left: TuiFocusItem | undefined, right: TuiFocusItem | undefined): boolean {
    if (left === undefined || right === undefined) {
        return left === right;
    }

    return left.kind === right.kind && left.id === right.id && (left.kind !== "line" || right.kind !== "line" || left.boxId === right.boxId);
}

