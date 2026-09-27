import {
    defineExtensionPoint,
    type ExtensionPointDeclaration,
} from "../ExtensionApi.js";

export type TuiPageTone =
    | "normal"
    | "muted"
    | "accent"
    | "success"
    | "warning"
    | "danger";

export interface TuiPageDeclaration extends ExtensionPointDeclaration {
    readonly id: string;
    readonly title: string;
}

export interface TuiPageLine {
    readonly text: string;
    readonly tone?: TuiPageTone;
}

export interface TuiPageAction {
    readonly id: string;
    readonly label: string;
    readonly tone?: "normal" | "danger";
}

export interface TuiPageItem {
    readonly actions?: readonly TuiPageAction[];
    readonly detail?: readonly TuiPageLine[];
    readonly id: string;
    readonly status?: "normal" | "ready" | "running" | "warning" | "failed" | "disabled" | "pending";
    readonly summary: readonly TuiPageLine[];
    readonly title: string;
}

export interface TuiPageSnapshot {
    readonly items: readonly TuiPageItem[];
}

export type TuiPageRequest =
    | { readonly kind: "read" }
    | {
          readonly actionId: string;
          readonly itemId?: string;
          readonly kind: "action";
      };

export interface TuiPageInvocationContext {
    /** True only for a request authenticated as the local Control owner. */
    readonly localOwner: boolean;
    readonly requestId: string;
    readonly signal: AbortSignal;
}

export type TuiPageBinding = (
    request: TuiPageRequest,
    context: TuiPageInvocationContext,
) => Promise<TuiPageSnapshot> | TuiPageSnapshot;

/** Host-rendered terminal page. This contract is intentionally TUI-specific. */
export const pages = defineExtensionPoint<TuiPageDeclaration, TuiPageBinding>(
    "tui.pages",
);
