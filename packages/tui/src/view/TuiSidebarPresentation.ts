import type { TuiSidebarEntry } from "../state/TuiViewModel.js";

export interface TuiSidebarViewport<T extends TuiSidebarEntry = TuiSidebarEntry> {
    items: readonly T[];
    startIndex: number;
}

export function tuiSidebarSectionRows(sidebarRows: number): {
    contextRows: number;
    instanceRows: number;
} {
    const innerRows = Math.max(0, sidebarRows - 2);
    const contextRows = Math.floor(innerRows / 2);
    return {
        contextRows,
        instanceRows: innerRows - contextRows,
    };
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
