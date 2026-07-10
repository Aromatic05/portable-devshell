export type PageId = "instances" | "config" | "connector" | "audit" | "logs" | "help";

export type SidebarFocus = "pages" | "instances";

export type FocusScope =
    | "sidebarPages"
    | "sidebarInstances"
    | "mainBoxes"
    | "boxDetail"
    | "form"
    | "wizard"
    | "search"
    | "toolForm"
    | "actionMenu"
    | "confirm";

export type SidebarCursor = { id: PageId; kind: "page" } | { id: string; kind: "instance" };

export type ExpandableBoxStatus = "normal" | "ready" | "running" | "warning" | "failed" | "disabled" | "pending";

export type TuiUiState = {
    selectedPage: PageId;
    selectedInstance?: string;
    sidebarFocus: SidebarFocus;
    focusScope: FocusScope;
    mainFocusId?: string;
    expandedBoxes: Record<string, boolean>;
    scrollOffsets: Record<string, number>;
    searchQueries: Record<string, string>;
    formDrafts: Record<string, unknown>;
    dirtyForms: Record<string, boolean>;
};

export type ActivePage = {
    page: PageId;
    instance: string | undefined;
};
