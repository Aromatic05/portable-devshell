import type { ArtifactViewImageResult } from "@portable-devshell/shared";

import type { TuiUiIntent } from "../TuiInteractionState.js";

export type TuiOverlay =
    | TuiConfirmationOverlay
    | TuiApprovalOverlay
    | TuiTextDetailOverlay
    | TuiSearchOverlay
    | TuiToolFormOverlay;

export interface TuiConfirmationOverlay {
    readonly body: string;
    readonly cancelLabel: string;
    readonly confirmIntent: TuiUiIntent;
    readonly confirmLabel: string;
    readonly kind: "confirmation";
    readonly selectedAction: "cancel" | "confirm";
    readonly title: string;
}

export interface TuiApprovalOverlay {
    readonly approvalId: string;
    readonly instance: string;
    readonly kind: "approval";
    readonly selectedAction: "back" | "input" | "deny" | "approve";
}


export interface TuiTextDetailOverlay {
    readonly body: string;
    readonly image?: ArtifactViewImageResult;
    readonly kind: "text-detail";
    readonly scrollOffset: number;
    readonly title: string;
}

export interface TuiSearchOverlay {
    readonly kind: "search";
    readonly page: string;
}

export interface TuiToolFormOverlay {
    readonly input: string;
    readonly instance: string;
    readonly kind: "tool-form";
    readonly toolName: string;
}

export function topTuiOverlay(overlays: readonly TuiOverlay[]): TuiOverlay | undefined {
    return overlays.at(-1);
}
