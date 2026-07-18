export function tuiTextDetailImageRows(viewportRows: number): number {
    const available = Math.max(2, Math.floor(viewportRows) - 4);
    return Math.max(2, Math.min(16, Math.floor(available * 0.6)));
}

export function tuiTextDetailBodyRows(viewportRows: number, hasImage: boolean): number {
    return Math.max(
        1,
        Math.floor(viewportRows) - 2 - (hasImage ? tuiTextDetailImageRows(viewportRows) + 1 : 0)
    );
}
