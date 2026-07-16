export type TuiPageId = "instances" | "todo" | "config" | "connector" | "oauth" | "audit" | "logs" | "help";

export type TuiSidebarFocus = "pages" | "instances";

export type TuiFocusScope =
    | "sidebarPages"
    | "sidebarInstances"
    | "mainBoxes"
    | "boxDetail"
    | "form"
    | "wizard"
    | "search"
    | "toolForm"
    | "confirm"
    | "approvalDetail"
    | "denyConfirm"
    | "textDetail";

export type TuiAuditPageMode = "list" | "approvalDetail" | "denyConfirm";

export type TuiAuditPageState = {
    approvalId?: string;
    listFocusId?: string;
    listScrollOffset?: number;
    mode: TuiAuditPageMode;
    selectedAction?: "approve" | "deny" | "back" | "input";
};

export type TuiSidebarCursor = { id: TuiPageId; kind: "page" } | { id: string; kind: "instance" };

export type TuiExpandableBoxStatus = "normal" | "ready" | "running" | "warning" | "failed" | "disabled" | "pending";

export type TuiUiState = {
    selectedPage: TuiPageId;
    selectedInstance?: string;
    sidebarFocus: TuiSidebarFocus;
    focusScope: TuiFocusScope;
    mainFocusId?: string;
    expandedBoxes: Record<string, boolean>;
    scrollOffsets: Record<string, number>;
    searchQueries: Record<string, string>;
    formDrafts: Record<string, unknown>;
    dirtyForms: Record<string, boolean>;
    logsFollowByInstance: Record<string, boolean>;
    logsPausedAtSeqByInstance: Record<string, number | undefined>;
    controlRestartRequired: boolean;
};

export type TuiActivePage = {
    page: TuiPageId;
    instance: string | undefined;
};
