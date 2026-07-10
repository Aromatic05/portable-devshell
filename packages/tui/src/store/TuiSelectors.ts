import { measureExpandableBoxHeight, type BoxModel } from "../component/ExpandableBox.js";
import type { TuiMode } from "../interaction/TuiInteractionTypes.js";
import type { ActivePage, PageId } from "../model/TuiUiTypes.js";
import { buildBoxesForPage } from "./page/buildBoxesForPage.js";
import { buildHelpLines } from "./page/help.js";
import type { TuiAppState, TuiConnectionState } from "./TuiReducers.js";

const pageEntries: Array<{ id: PageId; label: string }> = [
    { id: "instances", label: "instances" },
    { id: "config", label: "config" },
    { id: "connector", label: "connector" },
    { id: "audit", label: "audit" },
    { id: "logs", label: "logs" },
    { id: "help", label: "help" }
];

export interface SidebarEntry {
    focused: boolean;
    id: string;
    label: string;
    selected: boolean;
}

export interface SidebarModel {
    instances: SidebarEntry[];
    pages: SidebarEntry[];
}

export interface MainScreenModel {
    activePage: ActivePage;
    boxes: BoxModel[];
    emptyState?: string;
    errorLines?: string[];
    pageTitle: string;
    statusLine?: string;
}

export interface MainBoxFlowMetrics {
    boxRanges: Record<string, { end: number; start: number }>;
    scrollKey: string;
    totalLines: number;
}

export function selectActivePage(state: TuiAppState): ActivePage {
    return {
        instance: state.ui.selectedInstance,
        page: state.ui.selectedPage
    };
}

export function selectConnectionState(state: TuiAppState): TuiConnectionState {
    return state.connection;
}

export function selectHeaderTitle(): string {
    return "portable-devshell tui";
}

export function selectHeaderSummary(state: TuiAppState): string {
    return `instances ${state.instances.length} | live ${state.globalDerived.connectedInstanceCount} | approvals ${state.globalDerived.pendingApprovalCount} | events ${state.globalDerived.totalEventCount}`;
}

export function selectSidebarModel(state: TuiAppState): SidebarModel {
    const cursor = state.interaction.sidebarCursor;
    const sidebarFocused = state.interaction.focusScope === "sidebarPages" || state.interaction.focusScope === "sidebarInstances";

    return {
        instances: state.instances.map((instance) => ({
            focused: sidebarFocused && cursor?.kind === "instance" && cursor.id === instance.name,
            id: instance.name,
            label: instance.name,
            selected: state.ui.selectedInstance === instance.name
        })),
        pages: pageEntries.map((page) => ({
            focused: sidebarFocused && cursor?.kind === "page" && cursor.id === page.id,
            id: page.id,
            label: page.label,
            selected: state.ui.selectedPage === page.id
        }))
    };
}

export function selectMainScreenModel(state: TuiAppState): MainScreenModel {
    const activePage = selectActivePage(state);
    const statusLine = state.interaction.screenStatusByPage[activePage.page];
    const panelError = state.panelErrors[`${activePage.page}:${activePage.instance ?? "-"}`];
    const errorLines = panelError === undefined ? undefined : [`${panelError.code}: ${panelError.message}`];

    if (activePage.page !== "instances" && activePage.page !== "help" && activePage.instance === undefined) {
        return {
            activePage,
            boxes: [],
            emptyState: "No instance selected. Select one from the lower sidebar list.",
            errorLines,
            pageTitle: pageTitle(activePage.page),
            statusLine
        };
    }

    return {
        activePage,
        boxes: buildBoxesForPage(state, activePage.page, activePage.instance),
        errorLines,
        pageTitle: pageTitle(activePage.page),
        statusLine
    };
}

export function selectMainBoxIds(state: TuiAppState): string[] {
    return selectMainScreenModel(state).boxes.map((box) => box.id);
}

export function selectMainBoxFlowMetrics(state: TuiAppState): MainBoxFlowMetrics {
    const model = selectMainScreenModel(state);
    let cursor = 0;
    const boxRanges: Record<string, { end: number; start: number }> = {};

    for (const box of model.boxes) {
        const start = cursor;
        cursor += measureExpandableBoxHeight(box);
        boxRanges[box.id] = { end: cursor, start };
    }

    return {
        boxRanges,
        scrollKey: selectMainScrollKey(state),
        totalLines: cursor
    };
}

export function selectMainScrollKey(state: TuiAppState): string {
    return `${state.ui.selectedPage}:${state.ui.selectedPage === "instances" ? "collection" : state.ui.selectedInstance ?? "-"}:main`;
}

export function selectFooterModel(state: TuiAppState): { mode: TuiMode; text: string } {
    return {
        mode: state.interaction.focusScope,
        text: selectFooterText(state)
    };
}

export function selectFooterText(state: TuiAppState): string {
    const active = selectActivePage(state);
    const scope = state.interaction.focusScope;
    const instance = active.instance ?? "none";
    return `${state.connection.status} ${active.page}:${instance} ${scope} | ${selectFooterShortcuts(state).join(" ")}`;
}

export function selectFooterShortcuts(state: TuiAppState): string[] {
    switch (state.interaction.focusScope) {
        case "sidebarPages":
        case "sidebarInstances":
            return ["tab", "enter", "1-6", "↑↓", "esc"];
        case "mainBoxes":
            return ["tab", "enter", "space", "↑↓", "/", "a", "esc"];
        case "boxDetail":
            return ["enter", "↑↓", "/", "esc"];
        case "search":
            return ["type", "bs", "enter", "esc"];
        case "toolForm":
            return ["type JSON", "bs", "enter", "esc"];
        case "form":
            return ["tab", "enter", "ctrl+s", "ctrl+[", "ctrl+d"];
        case "wizard":
            return ["tab", "enter", "ctrl+s", "ctrl+[", "ctrl+d"];
        case "actionMenu":
            return ["↑↓", "enter", "esc"];
        case "confirm":
            return ["tab", "←→", "enter", "esc"];
        case "approvalDetail":
            return ["tab", "↑↓", "enter", "esc"];
        case "denyConfirm":
            return ["tab", "↑↓", "enter", "esc"];
    }
}

export function selectErrorMessage(state: TuiAppState): string[] | undefined {
    if (state.connection.errorCode === "control.notRunning") {
        return ["control server is not running.", "No instance is auto-started.", "Run `devshell start` manually if needed."];
    }

    if (typeof state.connection.errorMessage === "string" && state.connection.errorMessage.length > 0) {
        return [state.connection.errorMessage];
    }

    return undefined;
}

export function selectActionMenuModel(state: TuiAppState): { items: Array<{ active: boolean; id: string; label: string }>; open: boolean; title: string } {
    return {
        items: state.interaction.actionMenu.items.map((item) => ({
            active: state.interaction.selectedActionId === item.id,
            id: item.id,
            label: item.label
        })),
        open: state.interaction.actionMenu.open,
        title: state.interaction.actionMenu.title
    };
}

export function selectConfirmDialogModel(state: TuiAppState): {
    body: string;
    cancelFocused: boolean;
    cancelLabel: string;
    confirmFocused: boolean;
    confirmLabel: string;
    open: boolean;
    title: string;
} {
    return {
        body: state.interaction.confirmDialog.body,
        cancelFocused: state.interaction.selectedConfirmButton === "cancel",
        cancelLabel: state.interaction.confirmDialog.cancelLabel,
        confirmFocused: state.interaction.selectedConfirmButton === "confirm",
        confirmLabel: state.interaction.confirmDialog.confirmLabel,
        open: state.interaction.confirmDialog.open,
        title: state.interaction.confirmDialog.title
    };
}

export function selectSearchModel(state: TuiAppState): { open: boolean; query: string } {
    return {
        open: state.interaction.search.open,
        query: state.ui.searchQueries[state.ui.selectedPage] ?? ""
    };
}

export function selectExpanded(state: TuiAppState, key: string): boolean {
    return state.ui.expandedBoxes[key] === true;
}

export function selectHelpLines(state: TuiAppState): string[] {
    return buildHelpLines(state);
}

function pageTitle(page: PageId): string {
    return pageEntries.find((entry) => entry.id === page)?.label ?? page;
}
