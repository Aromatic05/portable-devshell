export interface TuiTextSelectionSpan {
    column: number;
    row: number;
    text: string;
}

export interface TuiTextSelectionSnapshot {
    characters: number;
    spans: readonly TuiTextSelectionSpan[];
}

export interface TuiTextSelectionRenderSource {
    getSnapshot(): TuiTextSelectionSnapshot;
    subscribe(listener: () => void): () => void;
}
