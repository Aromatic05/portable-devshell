import { selectErrorMessage, selectMainBoxFlowMetrics, selectMainScreenModel, selectSearchModel, selectSidebarModel } from "./model/TuiViewProjection.js";
import type { TuiAppState } from "../state/reducer/TuiStoreModel.js";
import { isTerminalSizeSupported, mainInnerWidth, tuiLayoutMetrics } from "./TuiRootLayout.js";

export type TuiHitTarget =
    | { boxId: string; kind: "boxBody"; lineId?: string }
    | { boxId: string; kind: "boxTitle" }
    | { id: string; kind: "instance" }
    | { id: string; kind: "page" }
    | { kind: "scrollViewport" };

export interface TuiHitRegion {
    height: number;
    target: TuiHitTarget;
    width: number;
    x: number;
    y: number;
}

export function buildTuiHitRegions(state: TuiAppState, viewport: { columns: number; rows: number }): TuiHitRegion[] {
    const regions: TuiHitRegion[] = [];
    const layout = tuiLayoutMetrics(viewport.columns);
    if (!isTerminalSizeSupported(viewport.columns, viewport.rows)) {
        return regions;
    }
    const sidebar = selectSidebarModel(state);
    const main = selectMainScreenModel(state);
    const metrics = selectMainBoxFlowMetrics(state, mainInnerWidth(viewport.columns));
    const search = selectSearchModel(state);
    const globalErrorHeight = blockHeight(selectErrorMessage(state));
    const toolFormHeight = state.interaction.toolForm?.open === true ? 6 : 0;
    const compact = layout.mode === "compact";
    const mainX = compact ? 2 : layout.outerGap + layout.sidebarWidth + layout.panelGap + 2;
    const mainWidth = compact ? Math.max(0, viewport.columns - 4) : Math.max(0, layout.mainPanelWidth - 2);
    const contentY = compact ? 6 : 5;
    let sidebarY = contentY;

    if (!compact) {
        for (const page of sidebar.pages) {
            regions.push({ height: 1, target: { id: page.id, kind: "page" }, width: layout.sidebarWidth - 2, x: layout.outerGap + 2, y: sidebarY++ });
        }
        sidebarY += 1;
        for (const instance of sidebar.instances) {
            regions.push({ height: 1, target: { id: instance.id, kind: "instance" }, width: layout.sidebarWidth - 2, x: layout.outerGap + 2, y: sidebarY++ });
        }
    }

    let mainY = contentY + globalErrorHeight + (search.open ? 1 : 0) + toolFormHeight;
    mainY += 1;
    mainY += blockHeight(main.errorLines);
    const viewportRows = Math.max(0, viewport.rows - (compact ? 10 : 7) - globalErrorHeight - (search.open ? 1 : 0) - (state.connection.status === "connecting" ? 1 : 0));
    const boxViewportRows = Math.max(0, viewportRows - 1 - (main.statusLine === undefined ? 0 : 1) - (main.emptyState === undefined ? 0 : 1));
    const scrollOffset = state.ui.scrollOffsets[metrics.scrollKey] ?? 0;
    const visibleEnd = Math.min(metrics.totalLines, scrollOffset + boxViewportRows);

    regions.push({ height: boxViewportRows, target: { kind: "scrollViewport" }, width: mainWidth, x: mainX, y: mainY });
    for (const box of main.boxes) {
        const range = metrics.boxRanges[box.id];
        if (range === undefined) {
            continue;
        }
        if (range.start >= visibleEnd || range.end <= scrollOffset) {
            continue;
        }
        const startY = mainY + Math.max(0, range.start - scrollOffset);
        if (range.start >= scrollOffset) {
            regions.push({ height: 1, target: { boxId: box.id, kind: "boxTitle" }, width: mainWidth, x: mainX, y: startY });
        }
        for (let lineIndex = Math.max(range.start + 1, scrollOffset); lineIndex < Math.min(range.end - 1, visibleEnd); lineIndex += 1) {
            const detail = box.expanded ? box.expandedLines[lineIndex - range.start - 1] : undefined;
            regions.push({
                height: 1,
                target: { boxId: box.id, kind: "boxBody", ...(detail?.id === undefined ? {} : { lineId: detail.id }) },
                width: mainWidth,
                x: mainX,
                y: mainY + lineIndex - scrollOffset
            });
        }
    }


    return regions;
}

export function hitTargetAt(regions: readonly TuiHitRegion[], x: number, y: number): TuiHitTarget | undefined {
    for (let index = regions.length - 1; index >= 0; index -= 1) {
        const region = regions[index]!;
        if (x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height) {
            return region.target;
        }
    }
    return undefined;
}

function blockHeight(lines: readonly string[] | undefined): number {
    return lines === undefined ? 0 : lines.length + 2;
}
