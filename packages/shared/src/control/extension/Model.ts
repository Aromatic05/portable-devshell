import type { JsonValue } from "../../types/Json.js";

export type ExtensionRuntimeState =
    "active" | "disabled" | "failed" | "installed";
export type ExtensionGenerationRuntimeState =
    "active" | "disposed" | "dispose-failed" | "draining" | "faulted" | "ready";

export interface ExtensionRuntimeFailure {
    generation?: string;
    message: string;
}

export interface ExtensionRetiredGenerationRecord {
    generation: string;
    inFlight: number;
    state: ExtensionGenerationRuntimeState;
}

export interface ExtensionRuntimeRecord {
    activeGeneration?: string;
    enabled: boolean;
    failure?: ExtensionRuntimeFailure;
    id: string;
    lastKnownGoodGeneration?: string;
    name?: string;
    retired: ExtensionRetiredGenerationRecord[];
    selectedGeneration?: string;
    state: ExtensionRuntimeState;
    version?: string;
}

export interface ExtensionRemoveResult {
    id: string;
    purged: boolean;
    removed: true;
}

export interface CliCommandDescriptor {
    extensionId: string;
    id: string;
    summary?: string;
    title: string;
    usage?: string;
}

export interface CliCommandWireResult {
    kind: "json" | "text";
    text?: string;
    value?: JsonValue;
}

export type TuiPageTone =
    "normal" | "muted" | "accent" | "success" | "warning" | "danger";

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
    readonly status?:
        | "normal"
        | "ready"
        | "running"
        | "warning"
        | "failed"
        | "disabled"
        | "pending";
    readonly summary: readonly TuiPageLine[];
    readonly title: string;
}

export interface TuiPageSnapshot {
    readonly items: readonly TuiPageItem[];
}

export interface WebApplicationDescriptor {
    extensionId: string;
    id: string;
    title: string;
}

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
