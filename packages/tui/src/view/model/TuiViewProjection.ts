import { measureExpandableBoxHeight } from "../component/TuiComponentExpandableBox.js";
import type { TuiMode } from "../../state/TuiInteractionState.js";
import type { TuiActivePage } from "../../state/TuiUiState.js";
import { buildBoxesForPage } from "../page/TuiPageBoxBuilder.js";
import { buildHelpLines } from "../page/TuiPageHelp.js";
import { selectTuiOverviewFocusIds } from "../page/TuiOverviewPresentation.js";
import type {
    TuiAppState,
    TuiConnectionState,
} from "../../state/reducer/TuiStoreModel.js";
import type {
    TuiBoxModel,
    TuiMainBoxFlowMetrics,
    TuiMainScreenModel,
    TuiPageLoadState,
    TuiSidebarModel,
} from "../../state/TuiViewModel.js";
import {
    currentTuiRoute,
    currentTuiRouteScrollKey,
    selectBreadcrumbSegments,
} from "../../state/route/TuiRouteState.js";
import type { TuiTerminalTab } from "../../state/route/TuiRoute.js";
import {
    isTuiSearchablePage,
    tuiPageEntries,
} from "../../state/TuiPageCatalog.js";
import { topTuiOverlay } from "../../state/overlay/TuiOverlay.js";

export function selectActivePage(state: TuiAppState): TuiActivePage {
    return {
        instance:
            state.ui.selectedPage === "overview" ||
            state.ui.selectedPage === "help"
                ? undefined
                : state.ui.selectedInstance,
        page: state.ui.selectedPage,
    };
}

export function selectTerminalTab(state: TuiAppState): TuiTerminalTab {
    const route = currentTuiRoute(state);
    return route.page === "terminal" ? route.tab : "instances";
}

export function selectConnectionState(state: TuiAppState): TuiConnectionState {
    return state.connection;
}

export function selectHeaderTitle(): string {
    return "portable-devshell tui";
}

export function selectHeaderSummary(state: TuiAppState): string {
    return `instances ${state.instances.length} | live ${state.globalDerived.connectedInstanceCount} | approvals ${state.globalDerived.pendingApprovalCount}`;
}

export function selectSidebarModel(state: TuiAppState): TuiSidebarModel {
    const cursor = state.interaction.sidebarCursor;
    const sidebarFocused =
        state.interaction.focusScope === "sidebarPages" ||
        state.interaction.focusScope === "sidebarInstances";

    return {
        instances: state.instances.map((instance) => ({
            focused:
                sidebarFocused &&
                cursor?.kind === "instance" &&
                cursor.id === instance.name,
            id: instance.name,
            label: instance.name,
            selected: state.ui.selectedInstance === instance.name,
        })),
        pages: tuiPageEntries.map((page) => ({
            focused:
                sidebarFocused &&
                cursor?.kind === "page" &&
                cursor.id === page.id,
            id: page.id,
            label: page.label,
            selected: state.ui.selectedPage === page.id,
        })),
    };
}

export function selectMainScreenModel(state: TuiAppState): TuiMainScreenModel {
    const activePage = selectActivePage(state);
    const statusLine = state.interaction.screenStatusByPage[activePage.page];
    const panelKey = `${activePage.page}:${activePage.instance ?? "-"}`;
    const panelErrors = Object.entries(state.panelErrors)
        .filter(([key]) => key === panelKey || key.startsWith(`${panelKey}:`))
        .map(([, error]) => error);
    const panelError = panelErrors[0];
    const errorLines = panelErrors.length === 0
        ? undefined
        : panelErrors.map((error) => `${error.code}: ${error.message}`);

    if (activePage.page === "overview") {
        return {
            activePage,
            boxes: [],
            errorLines,
            loadState: overviewLoadState(state, panelError?.message),
            pageTitle: pageTitle(state),
            statusLine,
        };
    }

    if (
        requiresInstance(activePage.page) &&
        activePage.instance === undefined
    ) {
        return {
            activePage,
            boxes: [],
            emptyState:
                "No instance selected. Select one from the lower sidebar list.",
            errorLines,
            loadState: { kind: "empty" },
            pageTitle: pageTitle(state),
            statusLine,
        };
    }

    const boxes = buildBoxesForPage(
        state,
        activePage.page,
        activePage.instance,
    );
    const query = state.ui.searchQueries[activePage.page] ?? "";
    const emptyState =
        query.length > 0 &&
        boxes.length === 0 &&
        isTuiSearchablePage(activePage.page)
            ? `No matches for "${query}".`
            : undefined;

    return {
        activePage,
        boxes,
        ...(emptyState === undefined ? {} : { emptyState }),
        errorLines,
        loadState: pageLoadState(state, boxes, panelError?.message),
        pageTitle: pageTitle(state),
        statusLine,
    };
}

export function selectMainBoxIds(state: TuiAppState): string[] {
    if (state.ui.selectedPage === "overview") {
        return selectTuiOverviewFocusIds(state);
    }
    return selectMainScreenModel(state).boxes.map((box) => box.id);
}

export function selectMainBoxFlowMetrics(
    state: TuiAppState,
    boxInnerWidth = 80,
): TuiMainBoxFlowMetrics {
    if (state.ui.selectedPage === "overview") {
        const scrollKey = selectMainScrollKey(state);
        const ids = selectTuiOverviewFocusIds(state);
        return {
            boxRanges: Object.fromEntries(
                ids.map((id, index) => [id, { end: index + 1, start: index }]),
            ),
            scrollKey,
            totalLines: ids.length,
        };
    }
    const model = selectMainScreenModel(state);
    return measureMainBoxFlowMetrics(
        model.boxes,
        selectMainScrollKey(state),
        boxInnerWidth,
    );
}

export function measureMainBoxFlowMetrics(
    boxes: readonly TuiBoxModel[],
    scrollKey: string,
    boxInnerWidth = 80,
): TuiMainBoxFlowMetrics {
    let cursor = 0;
    const boxRanges: Record<string, { end: number; start: number }> = {};
    for (const box of boxes) {
        const start = cursor;
        cursor += measureExpandableBoxHeight(box, boxInnerWidth);
        boxRanges[box.id] = { end: cursor, start };
    }
    return { boxRanges, scrollKey, totalLines: cursor };
}

export function selectMainScrollKey(state: TuiAppState): string {
    return currentTuiRouteScrollKey(state);
}

export function selectFooterModel(state: TuiAppState): {
    mode: TuiMode;
    text: string;
} {
    return {
        mode: state.interaction.focusScope,
        text: selectFooterText(state),
    };
}

export function selectFooterText(state: TuiAppState): string {
    const breadcrumb = selectBreadcrumbSegments(state).join(" / ");
    const shortcuts = selectFooterShortcuts(state).join(" · ");
    return shortcuts.length === 0
        ? breadcrumb
        : `${breadcrumb}  |  ${shortcuts}`;
}

export function selectFooterShortcuts(state: TuiAppState): string[] {
    switch (state.interaction.focusScope) {
        case "sidebarPages":
        case "sidebarInstances":
            return ["→ main", "tab", "enter", "0-8", "shift+1-9", "r", "↑↓"];
        case "mainBoxes":
            if (state.ui.selectedPage === "overview") {
                return [
                    "← sidebar",
                    "enter instance",
                    "r",
                    "↑↓",
                    "/",
                    "esc back",
                ];
            }
            return [
                "← sidebar",
                "enter detail",
                "space expand",
                "r",
                "↑↓",
                ...(isTuiSearchablePage(state.ui.selectedPage) ? ["/"] : []),
                "esc back",
            ];
        case "boxDetail":
            return [
                "enter",
                "space",
                "r",
                "↑↓",
                ...(isTuiSearchablePage(state.ui.selectedPage) ? ["/"] : []),
                "esc back",
            ];
        case "search":
            return ["type", "bs", "enter", "esc"];
        case "toolForm":
            return ["type JSON", "bs", "enter", "esc"];
        case "contextConversation":
            return ["type", "enter send", "pgup/pgdn", "esc"];
        case "form":
        case "wizard":
            return ["tab", "enter", "ctrl+s", "ctrl+[", "ctrl+d"];
        case "textDetail":
            return ["↑↓", "pgup/pgdn", "home/end", "enter", "esc"];
        case "confirm":
            return ["tab", "←→", "enter", "esc"];
        case "approvalDetail":
        case "denyConfirm":
            return ["tab", "↑↓", "enter", "esc"];
        case "terminal":
            return [
                "raw input",
                "drag copy",
                "shift+drag app mouse",
                "ctrl+t source",
                "shift+pgup/pgdn",
                "ctrl+] sidebar",
            ];
    }
}

export function selectErrorMessage(state: TuiAppState): string[] | undefined {
    if (state.connection.errorCode === "control.notRunning") {
        return [
            "control server is not running.",
            "No instance is auto-started.",
            "Run `devshell start` manually if needed.",
        ];
    }
    if (
        typeof state.connection.errorMessage === "string" &&
        state.connection.errorMessage.length > 0
    ) {
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
    const overlay = topTuiOverlay(state.interaction.overlays);
    if (overlay?.kind !== "confirmation") {
        return {
            body: "",
            cancelFocused: false,
            cancelLabel: "Cancel",
            confirmFocused: false,
            confirmLabel: "Confirm",
            open: false,
            title: "",
        };
    }
    return {
        body: overlay.body,
        cancelFocused: overlay.selectedAction === "cancel",
        cancelLabel: overlay.cancelLabel,
        confirmFocused: overlay.selectedAction === "confirm",
        confirmLabel: overlay.confirmLabel,
        open: true,
        title: overlay.title,
    };
}

export function selectSearchModel(state: TuiAppState): {
    open: boolean;
    query: string;
} {
    return {
        open: topTuiOverlay(state.interaction.overlays)?.kind === "search",
        query: state.ui.searchQueries[state.ui.selectedPage] ?? "",
    };
}

export function selectHelpLines(state: TuiAppState): string[] {
    return buildHelpLines(state);
}

function requiresInstance(page: TuiActivePage["page"]): boolean {
    return page !== "overview" && page !== "instances" && page !== "help";
}

function pageLoadState(
    state: TuiAppState,
    boxes: readonly TuiBoxModel[],
    error: string | undefined,
): TuiPageLoadState {
    if (error !== undefined)
        return boxes.length === 0
            ? { error, kind: "failed" }
            : { kind: "stale", reason: error };
    if (state.connection.status === "connecting" && boxes.length === 0)
        return { kind: "loading" };
    if (boxes.length === 0) return { kind: "empty" };
    return { kind: "ready" };
}

function overviewLoadState(
    state: TuiAppState,
    error: string | undefined,
): TuiPageLoadState {
    const available = state.readModel.overview !== undefined;
    if (error !== undefined)
        return available
            ? { kind: "stale", reason: error }
            : { error, kind: "failed" };
    if (state.connection.status === "connecting" && !available)
        return { kind: "loading" };
    return available ? { kind: "ready" } : { kind: "empty" };
}

function pageTitle(state: TuiAppState): string {
    const segments = selectBreadcrumbSegments(state);
    return segments.length === 0
        ? (tuiPageEntries.find((entry) => entry.id === state.ui.selectedPage)
              ?.label ?? state.ui.selectedPage)
        : segments.join(" / ");
}

export const tuiViewProjection = {
    selectMainBoxFlowMetrics,
    selectMainBoxIds,
    selectMainScreenModel,
    selectMainScrollKey,
};
