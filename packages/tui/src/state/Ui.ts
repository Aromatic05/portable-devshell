import { type TuiRoute, type TuiRouteViewState } from "./route/Model.js";

export type TuiPageId =
    | "overview"
    | "instances"
    | "todo"
    | "config"
    | "connections"
    | "messages"
    | "audit"
    | "logs"
    | "help"
    | "terminal";

export type TuiSidebarFocus = "context" | "instances";

export type TuiSidebarLevel = "root" | "section";

export type TuiMessageScope = "active" | "history";

export type TuiFocusScope =
    | "sidebarContext"
    | "sidebarInstances"
    | "mainBoxes"
    | "boxDetail"
    | "form"
    | "wizard"
    | "search"
    | "toolForm"
    | "contextConversation"
    | "confirm"
    | "approvalDetail"
    | "denyConfirm"
    | "textDetail"
    | "terminal";

export type TuiSidebarCursor =
    { id: string; kind: "context" } | { id: string; kind: "instance" };

export type TuiExpandableBoxStatus =
    | "normal"
    | "ready"
    | "running"
    | "warning"
    | "failed"
    | "disabled"
    | "pending";

export type TuiUiState = {
    selectedPage: TuiPageId;
    selectedInstance?: string;
    sidebarFocus: TuiSidebarFocus;
    sidebarLevel: TuiSidebarLevel;
    mainFocusId?: string;
    messageScope: TuiMessageScope;
    routeStacks: Record<string, readonly TuiRoute[]>;
    routeViewStates: Record<string, TuiRouteViewState>;
    expandedBoxes: Record<string, boolean>;
    scrollOffsets: Record<string, number>;
    searchQueries: Record<string, string>;
    formDrafts: Record<string, unknown>;
    dirtyForms: Record<string, boolean>;
    logsClearedThroughSeqByInstance: Record<string, number>;
    logsFollowByInstance: Record<string, boolean>;
    logsPausedAtSeqByInstance: Record<string, number | undefined>;
    controlRestartRequired: boolean;
};

export type TuiActivePage = {
    page: TuiPageId;
    instance: string | undefined;
};

export type TuiBoxLineTone =
    "normal" | "muted" | "accent" | "success" | "warning" | "danger";

export interface TuiBoxLine {
    disabled?: boolean;
    editable?: boolean;
    editableValue?: {
        emptyPlaceholder?: string;
        kind: "choice" | "text";
        prefix: string;
        suffix?: string;
        value: string;
    };
    editing?: boolean;
    cursor?: number;
    cursorVisible?: boolean;
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

export type TuiSidebarContextTarget =
    | { kind: "page"; page: TuiPageId }
    | { kind: "root" }
    | { kind: "messageScope"; scope: TuiMessageScope }
    | { kind: "route"; route: TuiRoute };

export interface TuiSidebarContextEntry extends TuiSidebarEntry {
    shortcut?: string;
    target: TuiSidebarContextTarget;
}

export interface TuiSidebarModel {
    context: {
        items: TuiSidebarContextEntry[];
        kind: "audit" | "messages" | "pages";
    };
    instances: TuiSidebarEntry[];
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
