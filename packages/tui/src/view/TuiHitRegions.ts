import { topTuiOverlay } from "../state/overlay/TuiOverlay.js";
import type { TuiAppState } from "../state/reducer/TuiStoreModel.js";
import { currentTuiRoute } from "../state/route/TuiRouteState.js";
import type { TuiTerminalTab } from "../state/route/TuiRoute.js";
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
    selectTuiOverviewInstanceViewport,
    selectTuiOverviewPresentation,
} from "./page/TuiOverviewPresentation.js";
import { tuiTextDetailImageRows } from "./TuiTextDetailLayout.js";

export type TuiHitTarget =
    | { boxId: string; kind: "boxBody"; lineId?: string }
    | { boxId: string; kind: "boxTitle" }
    | { id: string; kind: "instance" }
    | { instance: string; kind: "overviewInstance" }
    | { id: string; kind: "page" }
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
    const metrics = selectMainBoxFlowMetrics(
        state,
        mainInnerWidth(viewport.columns),
    );
    const compact = layout.mode === "compact";
    const mainX = compact
        ? 2
        : layout.outerGap + layout.sidebarWidth + layout.panelGap + 2;
    const mainWidth = compact
        ? Math.max(0, viewport.columns - 4)
        : Math.max(0, layout.mainPanelWidth - 2);
    const contentY = compact ? 6 : 5;
    let sidebarY = contentY;

    if (!compact) {
        for (const page of sidebar.pages) {
            regions.push({
                height: 1,
                target: { id: page.id, kind: "page" },
                width: layout.sidebarWidth - 2,
                x: layout.outerGap + 2,
                y: sidebarY++,
            });
        }
        sidebarY += 1;
        for (const instance of sidebar.instances) {
            regions.push({
                height: 1,
                target: { id: instance.id, kind: "instance" },
                width: layout.sidebarWidth - 2,
                x: layout.outerGap + 2,
                y: sidebarY++,
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
        const startY = mainY + Math.max(0, range.start - scrollOffset);
        if (range.start >= scrollOffset) {
            regions.push({
                height: 1,
                target: { boxId: box.id, kind: "boxTitle" },
                width: mainWidth,
                x: mainX,
                y: startY,
            });
        }
        for (
            let lineIndex = Math.max(range.start + 1, scrollOffset);
            lineIndex < Math.min(range.end - 1, visibleEnd);
            lineIndex += 1
        ) {
            const detail = box.expanded
                ? box.expandedLines[lineIndex - range.start - 1]
                : undefined;
            regions.push({
                height: 1,
                target: {
                    boxId: box.id,
                    kind: "boxBody",
                    ...(detail?.id === undefined ? {} : { lineId: detail.id }),
                },
                width: mainWidth,
                x: mainX,
                y: mainY + lineIndex - scrollOffset,
            });
        }
    }

    if (state.ui.selectedPage === "terminal") {
        pushTerminalTabRegions(regions, mainX, contentY + globalErrorHeight + 1);
    }

    return regions;
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
