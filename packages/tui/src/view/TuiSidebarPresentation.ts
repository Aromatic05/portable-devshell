import type { TuiSidebarEntry } from "../state/TuiViewModel.js";
import { tuiLayoutMetrics, tuiRenderRows } from "./TuiRootLayout.js";

export interface TuiSidebarRegion {
    height: number;
    width: number;
    x: number;
    y: number;
}

export interface TuiSidebarRegions {
    context: TuiSidebarRegion;
    instances: TuiSidebarRegion;
    sidebar: TuiSidebarRegion;
}

export interface TuiSidebarViewport<T extends TuiSidebarEntry = TuiSidebarEntry> {
    items: readonly T[];
    startIndex: number;
}

export function tuiSidebarSectionRows(sidebarRows: number): {
    contextRows: number;
    instanceRows: number;
} {
    const innerRows = Math.max(0, sidebarRows - 3);
    const contextRows = Math.floor(innerRows / 2);
    return {
        contextRows,
        instanceRows: innerRows - contextRows,
    };
}

export function tuiSidebarRegions(viewport: {
    columns: number;
    rows: number;
}): TuiSidebarRegions | undefined {
    const layout = tuiLayoutMetrics(viewport.columns);
    if (layout.mode === "compact") return undefined;

    const sidebarRows = Math.max(0, tuiRenderRows(viewport.rows) - 6);
    const sectionRows = tuiSidebarSectionRows(sidebarRows);
    const sidebar = {
        height: sidebarRows,
        width: layout.sidebarWidth,
        x: layout.outerGap + 1,
        y: 4,
    };
    const contentX = sidebar.x + 2;
    const contentWidth = Math.max(0, sidebar.width - 4);
    const contextY = sidebar.y + 1;

    return {
        context: {
            height: sectionRows.contextRows,
            width: contentWidth,
            x: contentX,
            y: contextY,
        },
        instances: {
            height: sectionRows.instanceRows,
            width: contentWidth,
            x: contentX,
            y: contextY + sectionRows.contextRows + 1,
        },
        sidebar,
    };
}

export function tuiSidebarSectionAt(
    viewport: { columns: number; rows: number },
    x: number,
    y: number,
): "context" | "instances" | undefined {
    const regions = tuiSidebarRegions(viewport);
    if (regions === undefined || !containsPoint(regions.sidebar, x, y)) {
        return undefined;
    }
    if (containsPoint(regions.context, x, y)) return "context";
    if (containsPoint(regions.instances, x, y)) return "instances";
    return undefined;
}

export function selectTuiSidebarViewport<T extends TuiSidebarEntry>(
    items: readonly T[],
    rows: number,
): TuiSidebarViewport<T> {
    const visibleRows = Math.max(0, rows);
    if (visibleRows === 0 || items.length === 0) {
        return { items: [], startIndex: 0 };
    }
    if (items.length <= visibleRows) {
        return { items, startIndex: 0 };
    }

    const focusedIndex = items.findIndex((item) => item.focused);
    const selectedIndex = items.findIndex((item) => item.selected);
    const anchorIndex = focusedIndex >= 0
        ? focusedIndex
        : selectedIndex >= 0
          ? selectedIndex
          : 0;
    const startIndex = Math.min(
        Math.max(0, anchorIndex - Math.floor(visibleRows / 2)),
        items.length - visibleRows,
    );
    return {
        items: items.slice(startIndex, startIndex + visibleRows),
        startIndex,
    };
}

function containsPoint(region: TuiSidebarRegion, x: number, y: number): boolean {
    return (
        x >= region.x &&
        x < region.x + region.width &&
        y >= region.y &&
        y < region.y + region.height
    );
}
