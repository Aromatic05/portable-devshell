export type TuiPageTone =
    | "normal"
    | "muted"
    | "accent"
    | "success"
    | "warning"
    | "danger";

export interface TuiPageDescriptor {
    readonly extensionId: string;
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
