import type { TuiActivePage, TuiExpandableBoxStatus } from "./TuiUiState.js";

export type TuiBoxLineTone = "normal" | "muted" | "accent" | "success" | "warning" | "danger";

export interface TuiBoxLine {
    disabled?: boolean;
    id?: string;
    text: string;
    tone?: TuiBoxLineTone;
}

export interface TuiBoxModel {
    collapsedLines: readonly [TuiBoxLine] | readonly [TuiBoxLine, TuiBoxLine];
    disabled?: boolean;
    expanded: boolean;
    expandedKey: string;
    expandedLines: readonly TuiBoxLine[];
    focused: boolean;
    id: string;
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

export interface TuiMainScreenModel {
    activePage: TuiActivePage;
    boxes: TuiBoxModel[];
    emptyState?: string;
    errorLines?: string[];
    pageTitle: string;
    statusLine?: string;
}

export interface TuiMainBoxFlowMetrics {
    boxRanges: Record<string, { end: number; start: number }>;
    scrollKey: string;
    totalLines: number;
}
