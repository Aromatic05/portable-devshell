import { topTuiOverlay } from "../state/overlay/TuiOverlay.js";
import type { TuiAppState } from "../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../state/route/TuiRouteState.js";
import type { TuiTerminalTab } from "../state/route/TuiRoute.js";
import { renderExpandableBoxLines } from "./component/TuiComponentExpandableBox.js";
import { tuiTerminalTabLabel, tuiTerminalTabs } from "./page/terminal/TuiTmuxPaneTerminalModel.js";
import {
    selectErrorMessage,
    selectMainBoxFlowMetrics,
    selectMainScreenModel,
    selectSidebarModel,
} from "./model/TuiViewProjection.js";
import {
    isTerminalSizeSupported,
    mainInnerWidth,
    tuiLayoutMetrics,
} from "./TuiRootLayout.js";
import {
    selectTuiSidebarViewport,
    tuiSidebarRegions,
} from "./TuiSidebarPresentation.js";
import type { TuiTextSelectionColumnBounds } from "./TuiTextSelectionModel.js";
import {
    selectTuiOverviewInstanceViewport,
    selectTuiOverviewPresentation,
} from "./page/TuiOverviewPresentation.js";
import {
    renderTuiMessageHistoryLines,
    tuiMessagesRenderedHistoryRows,
} from "./page/messages/TuiMessagesProjection.js";
import { tuiTextDetailImageRows } from "./TuiTextDetailLayout.js";

export type TuiHitTarget =
    | { boxId: string; kind: "boxBody"; lineId?: string }
    | { boxId: string; kind: "boxTitle" }
    | { id: string; kind: "context" }
    | { id: string; kind: "instance" }
    | { kind: "messagesViewport" }
    | { instance: string; kind: "overviewInstance" }
    | { kind: "scrollViewport" }
    | { kind: "terminalTab"; tab: TuiTerminalTab };

export function tuiTerminalFullScreen(state: TuiAppState): boolean {
    void state;
    return false;
}

export interface TuiHitRegion {
    height: number;
    target: TuiHitTarget;
    width: number;
    x: number;
    y: number;
}

export interface TuiTerminalViewportRegion {
    height: number;
    width: number;
    x: number;
    y: number;
}

export function buildTuiTerminalViewportRegion(
    state: TuiAppState,
    viewport: { columns: number; rows: number },
): TuiTerminalViewportRegion | undefined {
    const route = currentTuiRoute(state);
    if (
        state.ui.selectedPage !== "terminal" ||
        route.page !== "terminal" ||
        route.tab !== "instances" ||
        topTuiOverlay(state.interaction.overlays) !== undefined ||
        !isTerminalSizeSupported(viewport.columns, viewport.rows)
    ) {
        return undefined;
    }

    const layout = tuiLayoutMetrics(viewport.columns);
    const compact = layout.mode === "compact";
    const globalErrorHeight = blockHeight(selectErrorMessage(state));
    const viewportRows = Math.max(
        0,
        viewport.rows -
            (compact ? 10 : 7) -
            globalErrorHeight -
            (state.connection.status === "connecting" ? 1 : 0),
    );

    return {
        height: Math.max(1, viewportRows - 2),
        width: Math.max(1, mainInnerWidth(viewport.columns)),
        x: compact
            ? 2
            : layout.outerGap + layout.sidebarWidth + layout.panelGap + 2,
        y: (compact ? 6 : 5) + globalErrorHeight + 2,
    };
}

export function buildTuiTextDetailImageRegion(
    state: TuiAppState,
    viewport: { columns: number; rows: number },
): TuiTerminalViewportRegion | undefined {
    const overlay = topTuiOverlay(state.interaction.overlays);
    if (
        overlay?.kind !== "text-detail" ||
        overlay.image === undefined ||
        !isTerminalSizeSupported(viewport.columns, viewport.rows)
    ) {
        return undefined;
    }

    const layout = tuiLayoutMetrics(viewport.columns);
    const compact = layout.mode === "compact";
    const globalErrorHeight = blockHeight(selectErrorMessage(state));
    const viewportRows = Math.max(
        0,
        viewport.rows -
            (compact ? 10 : 7) -
            globalErrorHeight -
            (state.connection.status === "connecting" ? 1 : 0),
    );

    return {
        height: tuiTextDetailImageRows(viewportRows),
        width: Math.max(1, mainInnerWidth(viewport.columns)),
        x: compact
            ? 2
            : layout.outerGap + layout.sidebarWidth + layout.panelGap + 2,
        y: (compact ? 6 : 5) + globalErrorHeight + 2,
    };
}

export function buildTuiHitRegions(
    state: TuiAppState,
    viewport: { columns: number; rows: number },
): TuiHitRegion[] {
    if (
        !isTerminalSizeSupported(viewport.columns, viewport.rows) ||
        topTuiOverlay(state.interaction.overlays) !== undefined
    ) {
        return [];
    }

    const regions: TuiHitRegion[] = [];
    const globalErrorHeight = blockHeight(selectErrorMessage(state));
    if (tuiTerminalFullScreen(state)) {
        pushTerminalTabRegions(regions, 2, 5 + globalErrorHeight + 1);
        return regions;
    }

    const layout = tuiLayoutMetrics(viewport.columns);
    const sidebar = selectSidebarModel(state);
    const main = selectMainScreenModel(state);
    const boxInnerWidth = mainInnerWidth(viewport.columns);
    const metrics = selectMainBoxFlowMetrics(state, boxInnerWidth);
    const compact = layout.mode === "compact";
    const mainX = compact
        ? 2
        : layout.outerGap + layout.sidebarWidth + layout.panelGap + 2;
    const mainWidth = compact
        ? Math.max(0, viewport.columns - 4)
        : Math.max(0, layout.mainPanelWidth - 2);
    const contentY = compact ? 6 : 5;
    if (!compact) {
        const sidebarRegions = tuiSidebarRegions(viewport)!;
        const contextViewport = selectTuiSidebarViewport(
            sidebar.context.items,
            sidebarRegions.context.height,
        );
        const instanceViewport = selectTuiSidebarViewport(
            sidebar.instances,
            sidebarRegions.instances.height,
        );
        for (const [index, entry] of contextViewport.items.entries()) {
            regions.push({
                height: 1,
                target: { id: entry.id, kind: "context" },
                width: sidebarRegions.context.width,
                x: sidebarRegions.context.x,
                y: sidebarRegions.context.y + index,
            });
        }
        for (const [index, instance] of instanceViewport.items.entries()) {
            regions.push({
                height: 1,
                target: { id: instance.id, kind: "instance" },
                width: sidebarRegions.instances.width,
                x: sidebarRegions.instances.x,
                y: sidebarRegions.instances.y + index,
            });
        }
    }

    const viewportRows = Math.max(
        0,
        viewport.rows -
            (compact ? 10 : 7) -
            globalErrorHeight -
            (state.connection.status === "connecting" ? 1 : 0),
    );
    if (state.ui.selectedPage === "messages") {
        const route = currentTuiRoute(state);
        if (
            route.page === "messages" &&
            route.view === "thread" &&
            state.ui.selectedInstance !== undefined
        ) {
            const historyLines = renderTuiMessageHistoryLines(
                state,
                state.ui.selectedInstance,
                route.ctxId,
                boxInnerWidth,
            );
            const contentRows =
                tuiMessagesRenderedHistoryRows(historyLines.length, viewportRows) + 3;
            regions.push({
                height: Math.max(1, contentRows),
                target: { kind: "messagesViewport" },
                width: mainWidth,
                x: mainX,
                y: contentY + globalErrorHeight,
            });
        }
        return regions;
    }
    if (state.ui.selectedPage === "overview") {
        const overview = selectTuiOverviewPresentation(state);
        const overviewViewport = selectTuiOverviewInstanceViewport(
            state,
            viewportRows,
        );
        const stateRows = main.loadState.kind === "ready" ? 0 : 1;
        const mainY =
            contentY +
            globalErrorHeight +
            blockHeight(main.errorLines) +
            stateRows;
        const firstInstanceY = mainY + 4 + overview.meters.length;
        regions.push({
            height: Math.max(1, viewportRows),
            target: { kind: "scrollViewport" },
            width: mainWidth,
            x: mainX,
            y: mainY,
        });
        overviewViewport.rows.forEach((row, index) => {
            regions.push({
                height: 1,
                target: { instance: row.name, kind: "overviewInstance" },
                width: mainWidth,
                x: mainX,
                y: firstInstanceY + index,
            });
        });
        return regions;
    }

    const mainY =
        contentY + globalErrorHeight + 1 + blockHeight(main.errorLines);
    const stateRows = main.loadState.kind === "ready" ? 0 : 1;
    const boxViewportRows = Math.max(
        0,
        viewportRows -
            1 -
            stateRows -
            (main.statusLine === undefined ? 0 : 1) -
            (main.emptyState === undefined ? 0 : 1),
    );
    const scrollOffset = state.ui.scrollOffsets[metrics.scrollKey] ?? 0;
    const visibleEnd = Math.min(
        metrics.totalLines,
        scrollOffset + boxViewportRows,
    );

    regions.push({
        height: boxViewportRows,
        target: { kind: "scrollViewport" },
        width: mainWidth,
        x: mainX,
        y: mainY,
    });
    for (const box of main.boxes) {
        const range = metrics.boxRanges[box.id];
        if (
            range === undefined ||
            range.start >= visibleEnd ||
            range.end <= scrollOffset
        )
            continue;
        const lines = renderExpandableBoxLines(box, boxInnerWidth);
        if (range.start >= scrollOffset) {
            regions.push({
                height: 1,
                target: { boxId: box.id, kind: "boxTitle" },
                width: mainWidth,
                x: mainX,
                y: mainY + range.start - scrollOffset,
            });
        }
        const firstBodyOffset = Math.max(1, scrollOffset - range.start);
        const endBodyOffset = Math.min(
            lines.length - 1,
            visibleEnd - range.start,
        );
        for (let offset = firstBodyOffset; offset < endBodyOffset; offset += 1) {
            const line = lines[offset];
            if (line === undefined) continue;
            regions.push({
                height: 1,
                target: {
                    boxId: box.id,
                    kind: "boxBody",
                    ...(line.lineId === undefined ? {} : { lineId: line.lineId }),
                },
                width: mainWidth,
                x: mainX,
                y: mainY + range.start + offset - scrollOffset,
            });
        }
    }

    if (state.ui.selectedPage === "terminal") {
        pushTerminalTabRegions(regions, mainX, contentY + globalErrorHeight + 1);
    }

    return regions;
}

export function tuiScreenSelectionColumnBounds(
    state: TuiAppState,
    viewport: { columns: number; rows: number },
    x: number,
    y: number,
): TuiTextSelectionColumnBounds | undefined {
    if (topTuiOverlay(state.interaction.overlays) !== undefined) {
        return undefined;
    }
    const layout = tuiLayoutMetrics(viewport.columns);
    if (layout.mode !== "full") {
        return undefined;
    }
    const sidebar = tuiSidebarRegions(viewport);
    if (sidebar === undefined) {
        return undefined;
    }
    const row = Math.floor(y);
    if (
        row < sidebar.sidebar.y ||
        row >= sidebar.sidebar.y + sidebar.sidebar.height
    ) {
        return undefined;
    }
    const mainStart =
        layout.outerGap + layout.sidebarWidth + layout.panelGap + 2;
    if (Math.floor(x) < mainStart) {
        return {
            end: sidebar.context.x + sidebar.context.width - 1,
            start: sidebar.context.x - 1,
        };
    }
    return {
        end: mainStart + Math.max(0, layout.mainPanelWidth - 2) - 1,
        start: mainStart - 1,
    };
}

export function hitTargetAt(
    regions: readonly TuiHitRegion[],
    x: number,
    y: number,
): TuiHitTarget | undefined {
    for (let index = regions.length - 1; index >= 0; index -= 1) {
        const region = regions[index]!;
        if (
            x >= region.x &&
            x < region.x + region.width &&
            y >= region.y &&
            y < region.y + region.height
        ) {
            return region.target;
        }
    }
    return undefined;
}

function blockHeight(lines: readonly string[] | undefined): number {
    return lines === undefined ? 0 : lines.length + 2;
}

function pushTerminalTabRegions(
    regions: TuiHitRegion[],
    startX: number,
    y: number,
): void {
    let tabX = startX;
    for (const tab of tuiTerminalTabs) {
        const width = tuiTerminalTabLabel(tab).length + 2;
        regions.push({
            height: 1,
            target: { kind: "terminalTab", tab },
            width,
            x: tabX,
            y,
        });
        tabX += width + 1;
    }
}
