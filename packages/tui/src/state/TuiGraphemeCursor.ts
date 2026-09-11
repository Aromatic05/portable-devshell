const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function normalizeTuiGraphemeCursor(text: string, requested: number): number {
    const cursor = Math.min(Math.max(0, requested), text.length);
    if (cursor === 0 || cursor === text.length) return cursor;
    for (const segment of graphemeSegmenter.segment(text)) {
        const start = segment.index;
        const end = start + segment.segment.length;
        if (cursor <= start) return start;
        if (cursor <= end) return end;
    }
    return text.length;
}

export function previousTuiGraphemeCursor(text: string, requested: number): number {
    const cursor = normalizeTuiGraphemeCursor(text, requested);
    let previous = 0;
    for (const segment of graphemeSegmenter.segment(text)) {
        if (segment.index >= cursor) break;
        previous = segment.index;
    }
    return previous;
}

export function nextTuiGraphemeCursor(text: string, requested: number): number {
    const cursor = normalizeTuiGraphemeCursor(text, requested);
    for (const segment of graphemeSegmenter.segment(text)) {
        const end = segment.index + segment.segment.length;
        if (segment.index >= cursor && end > cursor) return end;
    }
    return text.length;
}
