export interface WebPageDescriptor {
    readonly extensionId: string;
    readonly id: string;
    readonly title: string;
}

export type WebPageTone = "normal" | "success" | "warning" | "danger";

export interface WebPageCell {
    readonly href?: string;
    readonly text: string;
    readonly tone?: WebPageTone;
}

export interface WebPageColumn {
    readonly id: string;
    readonly label: string;
}

export interface WebPageAction {
    readonly id: string;
    readonly label: string;
    readonly tone?: "normal" | "danger";
}

export interface WebPageRow {
    readonly actions?: readonly WebPageAction[];
    readonly cells: Readonly<Record<string, WebPageCell>>;
    readonly id: string;
}

export interface WebPageTable {
    readonly columns: readonly WebPageColumn[];
    readonly id: string;
    readonly rows: readonly WebPageRow[];
    readonly title?: string;
}

export interface WebPageSnapshot {
    readonly tables: readonly WebPageTable[];
}
