import { measureExpandableBoxHeight } from "../component/content/Box.js";
import type { TuiMode } from "../../state/Interaction.js";
import type { TuiActivePage } from "../../state/Ui.js";
import { buildBoxesForPage } from "../page/Builder.js";
import { buildHelpLines } from "../page/Help.js";
import {
    auditInputText,
    auditOutputText,
    resolveAuditOutput,
} from "../page/activity/audit/projection/Detail.js";
import { selectTuiOverviewFocusIds } from "../page/overview/Presentation.js";
import type {
    TuiAppState,
    TuiConnectionState,
} from "../../state/store/Model.js";
import type {
    TuiBoxModel,
    TuiMainBoxFlowMetrics,
    TuiMainScreenModel,
    TuiPageLoadState,
    TuiSidebarContextEntry,
    TuiSidebarModel,
} from "../../state/Ui.js";
import {
    currentTuiRoute,
    currentTuiRouteScrollKey,
    selectBreadcrumbSegments,
} from "../../state/route/State.js";
import type { TuiTerminalTab } from "../../state/route/Model.js";
import {
    isTuiSearchablePage,
    tuiPageEntries,
    tuiPageShortcut,
} from "../../state/route/Navigation.js";
import { topTuiOverlay } from "../../state/Overlay.js";
import { selectTuiAuditSidebarEntries } from "../page/activity/audit/projection/Sidebar.js";
import {
    renderTuiMessageHistoryLines,
    selectTuiMessagesSidebarEntries,
} from "../page/activity/messages/Projection.js";
import type { TuiDomainReader } from "../domain/Reader.js";
import type { TuiInteractionProjection } from "../../interaction/Projection.js";

export function selectActivePage(state: TuiAppState): TuiActivePage {
    return {
        instance:
            state.ui.selectedPage === "overview" ||
            state.ui.selectedPage === "help" ||
            state.ui.selectedPage === "messages" ||
            state.ui.selectedPage === "extensions"
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

export function selectHeaderSummary(
    state: TuiAppState,
    domains: TuiDomainReader,
): string {
    const overview = domains.overview.overview;
    const instances = domains.instances.instances;
    const live =
        overview?.counts.instancesReady ??
        instances.filter((instance) => instance.snapshot?.ready === true).length;
    const approvals = overview?.counts.pendingApprovals ?? 0;
    return `instances ${instances.length} | live ${live} | approvals ${approvals}`;
}

export function selectSidebarModel(
    state: TuiAppState,
    domains: TuiDomainReader,
): TuiSidebarModel {
    const cursor = state.interaction.sidebarCursor;
    const contextFocused = state.interaction.focusScope === "sidebarContext";
    const instanceFocused = state.interaction.focusScope === "sidebarInstances";

    return {
        context: selectSidebarContext(state, domains, contextFocused, cursor),
        instances: domains.instances.instances.map((instance) => ({
            focused:
                instanceFocused &&
                cursor?.kind === "instance" &&
                cursor.id === instance.name,
            id: instance.name,
            label: instance.name,
            selected: state.ui.selectedInstance === instance.name,
        })),
    };
}

function selectSidebarContext(
    state: TuiAppState,
    domains: TuiDomainReader,
    focused: boolean,
    cursor: TuiAppState["interaction"]["sidebarCursor"],
): TuiSidebarModel["context"] {
    if (
        state.ui.sidebarLevel === "section" &&
        state.ui.selectedPage === "audit"
    ) {
        return {
            items: selectTuiAuditSidebarEntries(
                state,
                domains,
                focused,
                cursor,
            ),
            kind: "audit",
        };
    }
    if (
        state.ui.sidebarLevel === "section" &&
        state.ui.selectedPage === "messages"
    ) {
        return {
            items: selectTuiMessagesSidebarEntries(
                state,
                domains,
                focused,
                cursor,
            ),
            kind: "messages",
        };
    }
    return {
        items: tuiPageEntries.map((page): TuiSidebarContextEntry => ({
            focused:
                focused && cursor?.kind === "context" && cursor.id === page.id,
            id: page.id,
            label: page.label,
            selected: state.ui.selectedPage === page.id,
            shortcut: tuiPageShortcut(page.id),
            target: { kind: "page", page: page.id },
        })),
        kind: "pages",
    };
}

export function selectMainScreenModel(
    state: TuiAppState,
    domains: TuiDomainReader,
): TuiMainScreenModel {
    return projectMainScreenModel(state, domains);
}

function projectMainScreenModel(
    state: TuiAppState,
    domains: TuiDomainReader,
): TuiMainScreenModel {
    const activePage = selectActivePage(state);
    const statusLine = state.interaction.screenStatusByPage[activePage.page];
    const panelKey = `${activePage.page}:${activePage.instance ?? "-"}`;
    const panelErrors = Object.entries(state.panelErrors)
        .filter(([key]) => key === panelKey || key.startsWith(`${panelKey}:`))
        .map(([, error]) => error);
    const panelError = panelErrors[0];
    const errorLines =
        panelErrors.length === 0
            ? undefined
            : panelErrors.map((error) => `${error.code}: ${error.message}`);

    if (activePage.page === "overview") {
        return {
            activePage,
            boxes: [],
            errorLines,
            loadState: overviewLoadState(state, domains, panelError?.message),
            pageTitle: pageTitle(state, domains),
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
            pageTitle: pageTitle(state, domains),
            statusLine,
        };
    }

    const boxes = buildBoxesForPage(
        state,
        domains,
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
        loadState: pageLoadState(state, domains, boxes, panelError?.message),
        pageTitle: pageTitle(state, domains),
        statusLine,
    };
}

export function selectMainBoxIds(
    state: TuiAppState,
    domains: TuiDomainReader,
): string[] {
    if (state.ui.selectedPage === "overview") {
        return selectTuiOverviewFocusIds(state, domains);
    }
    return selectMainScreenModel(state, domains).boxes.map((box) => box.id);
}

export function selectMainBoxFlowMetrics(
    state: TuiAppState,
    domains: TuiDomainReader,
    boxInnerWidth = 80,
): TuiMainBoxFlowMetrics {
    const route = currentTuiRoute(state);
    if (
        route.page === "messages" &&
        route.view === "thread" &&
        state.ui.selectedInstance !== undefined
    ) {
        return {
            boxRanges: {},
            scrollKey: selectMainScrollKey(state),
            totalLines: renderTuiMessageHistoryLines(
                domains,
                state.ui.selectedInstance,
                route.ctxId,
                boxInnerWidth,
            ).length,
        };
    }
    if (state.ui.selectedPage === "overview") {
        const scrollKey = selectMainScrollKey(state);
        const ids = selectTuiOverviewFocusIds(state, domains);
        return {
            boxRanges: Object.fromEntries(
                ids.map((id, index) => [id, { end: index + 1, start: index }]),
            ),
            scrollKey,
            totalLines: ids.length,
        };
    }
    const model = selectMainScreenModel(state, domains);
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

export function selectFooterModel(
    state: TuiAppState,
    domains: TuiDomainReader,
): {
    mode: TuiMode;
    text: string;
} {
    return {
        mode: state.interaction.focusScope,
        text: selectFooterText(state, domains),
    };
}

export function selectFooterText(
    state: TuiAppState,
    domains: TuiDomainReader,
): string {
    const breadcrumb = selectBreadcrumbSegments(state, domains).join(" / ");
    const shortcuts = selectFooterShortcuts(state).join(" · ");
    return shortcuts.length === 0
        ? breadcrumb
        : `${breadcrumb}  |  ${shortcuts}`;
}

export function selectFooterShortcuts(state: TuiAppState): string[] {
    const route = currentTuiRoute(state);
    switch (state.interaction.focusScope) {
        case "sidebarContext":
            return state.ui.sidebarLevel === "section"
                ? state.ui.selectedPage === "messages"
                    ? [
                          "enter open/toggle",
                          state.ui.messageScope === "hidden"
                              ? "u restore"
                              : "d hide",
                          "/ search",
                          "esc back",
                          "? help",
                          "0-9 pages",
                          "shift+1-9 instances",
                      ]
                    : [
                          "enter open",
                          "esc back",
                          "? help",
                          "0-9 pages",
                          "shift+1-9 instances",
                      ]
                : [
                      "enter open",
                      "→ main",
                      "? help",
                      "0-9 pages",
                      "shift+1-9 instances",
                  ];
        case "sidebarInstances":
            return ["enter select", "→ main", "? help", "shift+1-9 instances"];
        case "mainBoxes":
            if (state.ui.selectedPage === "overview") {
                return ["← sidebar", "enter instance", "r", "/", "esc back"];
            }
            if (route.page === "audit" && route.view === "message") {
                return ["space expand", "↑↓ draft", "enter edit", "esc back"];
            }
            if (route.page === "audit" && route.view === "contexts") {
                return [
                    "← sidebar",
                    "enter context",
                    "space expand",
                    "/",
                    "esc back",
                ];
            }
            if (route.page === "audit") {
                return [
                    "← sidebar",
                    "enter expand",
                    "space expand",
                    ...(isAuditContextRoute(route) ? ["m comment"] : []),
                    "/",
                    "esc back",
                ];
            }
            return [
                "← sidebar",
                "enter detail",
                "space expand",
                ...(isAuditContextRoute(route) ? ["m comment"] : []),
                ...(isTuiSearchablePage(state.ui.selectedPage) ? ["/"] : []),
                "esc back",
            ];
        case "boxDetail":
            return [
                "enter",
                "space",
                "r",
                "↑↓",
                ...(isAuditContextRoute(route) ? ["m comment"] : []),
                ...(isTuiSearchablePage(state.ui.selectedPage) ? ["/"] : []),
                "esc back",
            ];
        case "search":
            return ["type", "bs", "enter", "esc"];
        case "toolForm":
            return ["type JSON", "bs", "enter", "esc"];
        case "contextMessage":
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

function isAuditContextRoute(
    route: ReturnType<typeof currentTuiRoute>,
): boolean {
    return (
        route.page === "audit" &&
        route.view === "context" &&
        route.scope === "context"
    );
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
    return (
        page !== "overview" &&
        page !== "instances" &&
        page !== "connections" &&
        page !== "messages" &&
        page !== "extensions" &&
        page !== "help"
    );
}

function pageLoadState(
    state: TuiAppState,
    domains: TuiDomainReader,
    boxes: readonly TuiBoxModel[],
    error: string | undefined,
): TuiPageLoadState {
    const route = currentTuiRoute(state);
    if (
        route.page === "extensions" &&
        route.view === "page" &&
        domains.extension.tuiSnapshots.get(route.pageId) === undefined &&
        error === undefined
    ) {
        return { kind: "loading" };
    }
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
    domains: TuiDomainReader,
    error: string | undefined,
): TuiPageLoadState {
    const available = domains.overview.overview !== undefined;
    if (error !== undefined)
        return available
            ? { kind: "stale", reason: error }
            : { error, kind: "failed" };
    if (state.connection.status === "connecting" && !available)
        return { kind: "loading" };
    return available ? { kind: "ready" } : { kind: "empty" };
}

function pageTitle(state: TuiAppState, domains: TuiDomainReader): string {
    const segments = selectBreadcrumbSegments(state, domains);
    return segments.length === 0
        ? (tuiPageEntries.find((entry) => entry.id === state.ui.selectedPage)
              ?.label ?? state.ui.selectedPage)
        : segments.join(" / ");
}

export function createTuiViewProjection(
    domains: TuiDomainReader,
): TuiInteractionProjection {
    return {
        auditInputText,
        auditOutputText,
        domains,
        resolveAuditOutput: (output, instance, callId) =>
            resolveAuditOutput(output, domains.runtime(instance).logs, callId),
        selectMainBoxFlowMetrics: (state, boxInnerWidth) =>
            selectMainBoxFlowMetrics(state, domains, boxInnerWidth),
        selectMainBoxIds: (state) => selectMainBoxIds(state, domains),
        selectMainScreenModel: (state) =>
            selectMainScreenModel(state, domains),
        selectMainScrollKey,
        selectSidebarModel: (state) => selectSidebarModel(state, domains),
    };
}
