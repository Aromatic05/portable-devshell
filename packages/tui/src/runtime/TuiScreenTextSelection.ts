import type { WriteStream } from "node:tty";

import headless from "@xterm/headless";

import type {
    TuiTextSelectionRenderSource,
    TuiTextSelectionSnapshot,
    TuiTextSelectionSpan,
} from "../view/TuiTextSelectionModel.js";

const { Terminal } = headless;
const EMPTY_SNAPSHOT: TuiTextSelectionSnapshot = {
    characters: 0,
    spans: [],
};

interface SelectionPoint {
    column: number;
    line: number;
}

export class TuiScreenTextSelection implements TuiTextSelectionRenderSource {
    readonly #listeners = new Set<() => void>();
    readonly #terminal;
    #columns: number;
    #rows: number;
    #pendingWrite: Promise<void> = Promise.resolve();
    #selection?: { anchor: SelectionPoint; focus: SelectionPoint };
    #snapshot = EMPTY_SNAPSHOT;

    constructor(options: { columns: number; rows: number }) {
        this.#columns = clampDimension(options.columns);
        this.#rows = clampDimension(options.rows);
        this.#terminal = new Terminal({
            allowProposedApi: true,
            cols: this.#columns,
            convertEol: true,
            rows: this.#rows,
            scrollback: 0,
        });
    }

    async beginSelection(x: number, y: number): Promise<void> {
        await this.flush();
        const point = this.#selectionPoint(x, y);
        this.#selection = { anchor: point, focus: point };
        this.#publish();
    }

    clearSelection(): void {
        if (this.#selection === undefined && this.#snapshot === EMPTY_SNAPSHOT) {
            return;
        }
        this.#selection = undefined;
        this.#snapshot = EMPTY_SNAPSHOT;
        this.#notify();
    }

    dispose(): void {
        this.#listeners.clear();
        this.#terminal.dispose();
    }

    async flush(): Promise<void> {
        await this.#pendingWrite;
    }

    getSelectionText(): string {
        return this.#selection === undefined
            ? ""
            : buildSelection(this.#terminal, this.#selection).text;
    }

    getSnapshot(): TuiTextSelectionSnapshot {
        return this.#snapshot;
    }

    resize(columns: number, rows: number): void {
        const nextColumns = clampDimension(columns);
        const nextRows = clampDimension(rows);
        if (nextColumns === this.#columns && nextRows === this.#rows) {
            return;
        }
        this.#columns = nextColumns;
        this.#rows = nextRows;
        this.#terminal.resize(nextColumns, nextRows);
        this.clearSelection();
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    updateSelection(x: number, y: number): void {
        if (this.#selection === undefined) {
            return;
        }
        this.#selection = {
            ...this.#selection,
            focus: this.#selectionPoint(x, y),
        };
        this.#publish();
    }

    write(data: string | Uint8Array): void {
        const value = typeof data === "string"
            ? data
            : Buffer.from(data).toString("utf8");
        this.#pendingWrite = this.#pendingWrite.then(
            () =>
                new Promise<void>((resolve) => {
                    this.#terminal.write(value, resolve);
                }),
        );
    }

    #notify(): void {
        for (const listener of this.#listeners) {
            listener();
        }
    }

    #publish(): void {
        if (this.#selection === undefined) {
            this.#snapshot = EMPTY_SNAPSHOT;
        } else {
            const selection = buildSelection(this.#terminal, this.#selection);
            this.#snapshot = {
                characters: [...selection.text].length,
                spans: selection.spans,
            };
        }
        this.#notify();
    }

    #selectionPoint(x: number, y: number): SelectionPoint {
        const buffer = this.#terminal.buffer.active;
        return {
            column: clamp(Math.floor(x) - 1, 0, this.#columns - 1),
            line:
                buffer.viewportY +
                clamp(Math.floor(y) - 1, 0, this.#rows - 1),
        };
    }
}

export function createTuiScreenCaptureStdout(
    stdout: WriteStream,
    selection: TuiScreenTextSelection,
): WriteStream {
    return new Proxy(stdout, {
        get(target, property) {
            if (property === "write") {
                return (chunk: unknown, ...args: unknown[]) => {
                    selection.resize(target.columns ?? 120, target.rows ?? 40);
                    if (
                        typeof chunk === "string" ||
                        Buffer.isBuffer(chunk) ||
                        chunk instanceof Uint8Array
                    ) {
                        selection.write(
                            typeof chunk === "string" ? chunk : Buffer.from(chunk),
                        );
                    }
                    return Reflect.apply(target.write, target, [chunk, ...args]);
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as WriteStream;
}

function buildSelection(
    terminal: InstanceType<typeof Terminal>,
    selection: { anchor: SelectionPoint; focus: SelectionPoint },
): { spans: TuiTextSelectionSpan[]; text: string } {
    const buffer = terminal.buffer.active;
    const [start, end] = orderedSelection(selection.anchor, selection.focus);
    const spans: TuiTextSelectionSpan[] = [];
    let text = "";

    for (let lineIndex = start.line; lineIndex <= end.line; lineIndex += 1) {
        const line = buffer.getLine(lineIndex);
        if (line === undefined) continue;
        const startColumn = lineIndex === start.line ? start.column : 0;
        const endColumn = lineIndex === end.line ? end.column + 1 : terminal.cols;
        const lineText = line.translateToString(true, startColumn, endColumn);
        if (lineText.length > 0) {
            spans.push({
                column: startColumn,
                row: lineIndex - buffer.viewportY,
                text: lineText,
            });
        }
        text += lineText;
        if (
            lineIndex < end.line &&
            buffer.getLine(lineIndex + 1)?.isWrapped !== true
        ) {
            text += "\n";
        }
    }

    return { spans, text };
}

function orderedSelection(
    left: SelectionPoint,
    right: SelectionPoint,
): [SelectionPoint, SelectionPoint] {
    if (
        left.line < right.line ||
        (left.line === right.line && left.column <= right.column)
    ) {
        return [left, right];
    }
    return [right, left];
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function clampDimension(value: number): number {
    return Math.max(1, Math.floor(value));
}
