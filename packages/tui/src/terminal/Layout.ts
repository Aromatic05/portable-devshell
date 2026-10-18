export function overviewInstanceViewportRows(viewportRows: number): number {
    return Math.max(1, Math.floor(Math.max(0, viewportRows - 10) * 0.45));
}

export function tuiMessagesHistoryRows(viewportRows: number): number {
    return Math.max(0, viewportRows - 4);
}

export function tuiBlockHeight(lines: readonly string[] | undefined): number {
    return lines === undefined ? 0 : lines.length + 2;
}
