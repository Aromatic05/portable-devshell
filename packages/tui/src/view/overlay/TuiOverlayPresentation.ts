import type { ApprovalRequest, ToolCallRecord } from "@portable-devshell/shared";
import stringWidth from "string-width";

import type { TuiConfirmationOverlay } from "../../state/overlay/TuiOverlay.js";
import { wrapTerminalText } from "../component/TuiComponentExpandableBox.js";

export type TuiApprovalAction = "back" | "input" | "deny" | "approve";
export type TuiConfirmationAction = "cancel" | "confirm";

export interface TuiOverlayActionLayout<Action extends string> {
    action: Action;
    width: number;
    x: number;
    y: number;
}

export interface TuiOverlayFrame {
    width: number;
    x: number;
    y: number;
}

export const tuiApprovalActions: readonly TuiApprovalAction[] = [
    "back",
    "input",
    "deny",
    "approve",
];

export function tuiApprovalFields(
    approval: ApprovalRequest,
    toolCall?: ToolCallRecord,
): readonly (readonly [string, string])[] {
    return [
        ["instance", approval.instance],
        ["approval", approval.approvalId],
        ["call", approval.callId],
        ["source", approval.source],
        ["tool", approval.toolName],
        ["workspace", approval.workspace ?? "-"],
        ["risk", approval.riskLevel],
        ["policy reason", approval.reason],
        ["requested", approval.createdAt],
        ["expires", approval.expiresAt],
        ["input summary", toolCall?.inputSummary ?? approval.inputSummary],
    ];
}

export function tuiConfirmationActionText(label: string): string {
    return `[ ${label} ]`;
}

export function tuiApprovalActionText(action: TuiApprovalAction): string {
    return ` ${action[0]!.toUpperCase()}${action.slice(1)} `;
}

export function projectTuiConfirmationActions(
    overlay: TuiConfirmationOverlay,
    frame: TuiOverlayFrame,
): readonly TuiOverlayActionLayout<TuiConfirmationAction>[] {
    const innerWidth = Math.max(1, frame.width - 4);
    const y =
        frame.y +
        1 +
        wrappedRows(overlay.title, innerWidth) +
        wrappedRows(overlay.body, innerWidth);
    const labels: readonly (readonly [TuiConfirmationAction, string])[] = [
        ["cancel", overlay.cancelLabel],
        ["confirm", overlay.confirmLabel],
    ];
    let x = frame.x + 2;
    return labels.map(([action, label], index) => {
        if (index > 0) x += 1;
        const width = stringWidth(tuiConfirmationActionText(label));
        const projected = { action, width, x, y };
        x += width;
        return projected;
    });
}

export function projectTuiApprovalActions(
    approval: ApprovalRequest,
    toolCall: ToolCallRecord | undefined,
    frame: TuiOverlayFrame,
): readonly TuiOverlayActionLayout<TuiApprovalAction>[] {
    const innerWidth = Math.max(1, frame.width - 4);
    const fieldRows = tuiApprovalFields(approval, toolCall).reduce(
        (rows, [label, value]) =>
            rows + wrappedRows(`${label}: ${value}`, innerWidth),
        0,
    );
    const y =
        frame.y +
        1 +
        wrappedRows("Approval", innerWidth) +
        fieldRows +
        1;
    let x = frame.x + 2;
    return tuiApprovalActions.map((action) => {
        const width = stringWidth(tuiApprovalActionText(action));
        const projected = { action, width, x, y };
        x += width;
        return projected;
    });
}

function wrappedRows(text: string, width: number): number {
    return Math.max(1, wrapTerminalText(text, width).length);
}
