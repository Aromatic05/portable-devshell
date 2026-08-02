import type { TuiRoute } from "./route/TuiRoute.js";
import type { TuiActivePage, TuiExpandableBoxStatus } from "./TuiUiState.js";

export type TuiBoxLineTone = "normal" | "muted" | "accent" | "success" | "warning" | "danger";

export interface TuiBoxLine {
    disabled?: boolean;
    editable?: boolean;
    id?: string;
    text: string;
    tone?: TuiBoxLineTone;
}

export type TuiBoxPrimaryAction = {
    readonly kind: "navigate";
    readonly route: TuiRoute;
};

export interface TuiBoxModel {
    collapsedLines: readonly [TuiBoxLine] | readonly [TuiBoxLine, TuiBoxLine];
    disabled?: boolean;
    editable?: boolean;
    enterable: boolean;
    expandable: boolean;
    expanded: boolean;
    expandedKey: string;
    expandedLines: readonly TuiBoxLine[];
    focused: boolean;
    id: string;
    primaryAction?: TuiBoxPrimaryAction;
    searchText?: string;
    severity?: TuiBoxLineTone;
    selectedDetailLineId?: string;
    status: TuiExpandableBoxStatus;
    title: string;
}

export interface TuiSidebarEntry {
    focused: boolean;
    id: string;
    label: string;
    selected: boolean;
}

export interface TuiSidebarModel {
    instances: TuiSidebarEntry[];
    pages: TuiSidebarEntry[];
}

export type TuiPageLoadState =
    | { kind: "loading" }
    | { kind: "ready" }
    | { kind: "empty" }
    | { error: string; kind: "failed" }
    | { reason: string; kind: "stale" };

export interface TuiMainScreenModel {
    activePage: TuiActivePage;
    boxes: TuiBoxModel[];
    emptyState?: string;
    errorLines?: string[];
    loadState: TuiPageLoadState;
    pageTitle: string;
    statusLine?: string;
}

export interface TuiMainBoxFlowMetrics {
    boxRanges: Record<string, { end: number; start: number }>;
    scrollKey: string;
    totalLines: number;
}
