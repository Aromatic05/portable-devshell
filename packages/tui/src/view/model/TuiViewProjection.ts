import { measureExpandableBoxHeight } from "../component/TuiComponentExpandableBox.js";
import type { TuiMode } from "../../state/TuiInteractionState.js";
import type { TuiActivePage, TuiPageId } from "../../state/TuiUiState.js";
import { buildBoxesForPage } from "../page/TuiPageBoxBuilder.js";
import { buildHelpLines } from "../page/TuiPageHelp.js";
import type { TuiAppState, TuiConnectionState } from "../../state/reducer/TuiStoreModel.js";
import type { TuiMainBoxFlowMetrics, TuiMainScreenModel, TuiSidebarModel } from "../../state/TuiViewModel.js";

const pageEntries: Array<{ id: TuiPageId; label: string }> = [
    { id: "instances", label: "instances" },
    { id: "config", label: "config" },
    { id: "connector", label: "connector" },
    { id: "oauth", label: "oauth" },
    { id: "audit", label: "audit" },
    { id: "logs", label: "logs" },
    { id: "todo", label: "todo" },
    { id: "help", label: "help" },
    { id: "terminal", label: "terminal" }
];

export function selectActivePage(state: TuiAppState): TuiActivePage {
    return {
        instance: state.ui.selectedPage === "oauth" || state.ui.selectedPage === "help" ? undefined : state.ui.selectedInstance,
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

export function selectSidebarModel(state: TuiAppState): TuiSidebarModel {
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

export function selectMainScreenModel(state: TuiAppState): TuiMainScreenModel {
    const activePage = selectActivePage(state);
    const statusLine = state.interaction.screenStatusByPage[activePage.page];
    const panelError = state.panelErrors[`${activePage.page}:${activePage.instance ?? "-"}`];
    const errorLines = panelError === undefined ? undefined : [`${panelError.code}: ${panelError.message}`];

    if (activePage.page !== "instances" && activePage.page !== "help" && activePage.page !== "oauth" && activePage.instance === undefined) {
        return {
            activePage,
            boxes: [],
            emptyState: "No instance selected. Select one from the lower sidebar list.",
            errorLines,
            pageTitle: pageTitle(activePage.page),
            statusLine
        };
    }

    const boxes = buildBoxesForPage(state, activePage.page, activePage.instance);
    const query = state.ui.searchQueries[activePage.page] ?? "";

    return {
        activePage,
        boxes,
        ...(query.length > 0 && boxes.length === 0 && isSearchablePage(activePage.page) ? { emptyState: `No matches for "${query}".` } : {}),
        errorLines,
        pageTitle: pageTitle(activePage.page),
        statusLine
    };
}

export function selectMainBoxIds(state: TuiAppState): string[] {
    return selectMainScreenModel(state).boxes.map((box) => box.id);
}

export function selectMainBoxFlowMetrics(state: TuiAppState, boxInnerWidth = 80): TuiMainBoxFlowMetrics {
    const model = selectMainScreenModel(state);
    let cursor = 0;
    const boxRanges: Record<string, { end: number; start: number }> = {};

    for (const box of model.boxes) {
        const start = cursor;
        cursor += measureExpandableBoxHeight(box, boxInnerWidth);
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
            return ["→ main", "tab", "enter", "1-9", "shift+1-9", "r", "↑↓", "esc"];
        case "mainBoxes":
            return ["← sidebar", "tab", "enter", "space", "r", "↑↓", ...(isSearchablePage(state.ui.selectedPage) ? ["/"] : []), "esc"];
        case "boxDetail":
            return ["← sidebar", "enter", "space", "r", "↑↓", ...(isSearchablePage(state.ui.selectedPage) ? ["/"] : []), "esc"];
        case "search":
            return ["type", "bs", "enter", "esc"];
        case "toolForm":
            return ["type JSON", "bs", "enter", "esc"];
        case "form":
            return ["tab", "enter", "ctrl+s", "ctrl+[", "ctrl+d"];
        case "wizard":
            return ["tab", "enter", "ctrl+s", "ctrl+[", "ctrl+d"];
        case "textDetail":
            return ["↑↓", "pgup/pgdn", "home/end", "enter", "esc"];
        case "confirm":
            return ["tab", "←→", "enter", "esc"];
        case "approvalDetail":
            return ["tab", "↑↓", "enter", "esc"];
        case "denyConfirm":
            return ["tab", "↑↓", "enter", "esc"];
        case "terminal":
            return ["raw input", "drag copy", "shift+drag app mouse", "shift+pgup/pgdn", "ctrl+] sidebar"];
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

export function selectHelpLines(state: TuiAppState): string[] {
    return buildHelpLines(state);
}

function isSearchablePage(page: TuiPageId): boolean {
    return page === "instances" || page === "todo" || page === "config" || page === "audit" || page === "logs";
}

function pageTitle(page: TuiPageId): string {
    return pageEntries.find((entry) => entry.id === page)?.label ?? page;
}
export const tuiViewProjection = {
    selectMainBoxFlowMetrics,
    selectMainBoxIds,
    selectMainScreenModel,
    selectMainScrollKey
};
