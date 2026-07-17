import headless from "@xterm/headless";
import type { IBufferCell, IBufferLine, Terminal as HeadlessTerminal } from "@xterm/headless";

import type {
    TuiTerminalBufferSnapshot,
    TuiTerminalDisposable,
    TuiTerminalGraphic,
    TuiTerminalGraphicProtocol,
    TuiTerminalLine,
    TuiTerminalMouseEvent,
    TuiTerminalSegment,
    TuiTerminalVisibleGraphic
} from "./TuiTerminalModel.js";

const ANSI_COLORS = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"
] as const;
const { Terminal } = headless;
const MAX_PERSISTENT_GRAPHICS = 128;
const MAX_PERSISTENT_GRAPHICS_BYTES = 16 * 1024 * 1024;

interface TuiTerminalSelectionPoint {
    column: number;
    line: number;
}

export class TuiTerminalBuffer {
    readonly #terminal: HeadlessTerminal;
    #focused = false;
    #graphicsRevision = 0;
    #mouseSgr = false;
    #mouseUnsupported = false;
    #pendingGraphics: TuiTerminalGraphic[] = [];
    #persistentGraphics: TuiTerminalGraphic[] = [];
    #selection?: {
        anchor: TuiTerminalSelectionPoint;
        focus: TuiTerminalSelectionPoint;
    };
    #title?: string;

    constructor(options: { columns: number; rows: number }) {
        this.#terminal = new Terminal({
            allowProposedApi: true,
            cols: clampDimension(options.columns),
            rows: clampDimension(options.rows),
            scrollback: 2_000
        });
        this.#terminal.onTitleChange((title) => {
            this.#title = title.length === 0 ? undefined : title;
        });
        this.#terminal.parser.registerCsiHandler({ final: "h", prefix: "?" }, (params) => {
            this.#updatePrivateModes(params, true);
            return false;
        });
        this.#terminal.parser.registerCsiHandler({ final: "l", prefix: "?" }, (params) => {
            this.#updatePrivateModes(params, false);
            return false;
        });
        this.#terminal.parser.registerEscHandler({ final: "c" }, () => {
            this.#mouseSgr = false;
            this.#mouseUnsupported = false;
            return false;
        });
    }

    dispose(): void {
        this.#terminal.dispose();
    }

    beginSelection(x: number, y: number): void {
        const point = this.#selectionPoint(x, y);
        this.#selection = { anchor: point, focus: point };
    }

    clearSelection(): void {
        this.#selection = undefined;
    }

    getSelectionText(): string {
        if (this.#selection === undefined) {
            return "";
        }
        const buffer = this.#terminal.buffer.active;
        const [start, end] = orderedSelection(this.#selection.anchor, this.#selection.focus);
        let output = "";
        for (let lineIndex = start.line; lineIndex <= end.line; lineIndex += 1) {
            const line = buffer.getLine(lineIndex);
            if (line === undefined) {
                continue;
            }
            const startColumn = lineIndex === start.line ? start.column : 0;
            const endColumn = lineIndex === end.line ? end.column + 1 : this.#terminal.cols;
            output += line.translateToString(true, startColumn, endColumn);
            if (lineIndex < end.line && buffer.getLine(lineIndex + 1)?.isWrapped !== true) {
                output += "\n";
            }
        }
        return output;
    }

    getVisibleGraphics(): TuiTerminalVisibleGraphic[] {
        const buffer = this.#terminal.buffer.active;
        const endLine = buffer.viewportY + this.#terminal.rows;
        return this.#persistentGraphics
            .filter((graphic) => graphic.line >= buffer.viewportY && graphic.line < endLine)
            .map((graphic) => ({
                ...graphic,
                x: graphic.column,
                y: graphic.line - buffer.viewportY
            }));
    }

    getSnapshot(): TuiTerminalBufferSnapshot {
        const buffer = this.#terminal.buffer.active;
        const cursor = {
            x: buffer.cursorX,
            y: buffer.baseY + buffer.cursorY - buffer.viewportY
        };
        const lines: TuiTerminalLine[] = [];

        for (let row = 0; row < this.#terminal.rows; row += 1) {
            const absoluteLine = buffer.viewportY + row;
            const line = buffer.getLine(absoluteLine);
            lines.push({
                segments: buildSegments(
                    line,
                    this.#terminal.cols,
                    row === cursor.y ? cursor.x : undefined,
                    this.#selectionRange(absoluteLine)
                )
            });
        }

        const selectionText = this.getSelectionText();

        return {
            columns: this.#terminal.cols,
            cursor,
            graphics: {
                count: this.#persistentGraphics.length,
                protocols: [...new Set(this.#persistentGraphics.map((graphic) => graphic.protocol))],
                revision: this.#graphicsRevision
            },
            lines,
            modes: {
                applicationCursorKeys: this.#terminal.modes.applicationCursorKeysMode,
                applicationKeypad: this.#terminal.modes.applicationKeypadMode,
                bracketedPaste: this.#terminal.modes.bracketedPasteMode,
                mouseEncoding: this.#mouseSgr ? "sgr" : this.#mouseUnsupported ? "unsupported" : "legacy",
                mouseTracking: this.#terminal.modes.mouseTrackingMode,
                sendFocus: this.#terminal.modes.sendFocusMode
            },
            rows: this.#terminal.rows,
            scroll: {
                atBottom: buffer.viewportY === buffer.baseY,
                historyLines: buffer.baseY,
                offsetFromBottom: Math.max(0, buffer.baseY - buffer.viewportY),
                viewportLine: buffer.viewportY
            },
            selection: selectionText.length === 0 ? undefined : { characters: [...selectionText].length },
            title: this.#title
        };
    }

    input(data: string): void {
        this.clearSelection();
        this.#terminal.input(encodeInput(data, {
            applicationCursorKeys: this.#terminal.modes.applicationCursorKeysMode,
            applicationKeypad: this.#terminal.modes.applicationKeypadMode
        }), true);
    }

    onData(listener: (data: string) => void): TuiTerminalDisposable {
        return this.#terminal.onData(listener);
    }

    resize(columns: number, rows: number): void {
        this.clearSelection();
        this.#terminal.resize(clampDimension(columns), clampDimension(rows));
    }

    paste(data: string): void {
        this.clearSelection();
        this.#terminal.input(
            this.#terminal.modes.bracketedPasteMode
                ? `\u001B[200~${data}\u001B[201~`
                : data,
            true
        );
    }

    recordGraphic(protocol: TuiTerminalGraphicProtocol, sequence: string): void {
        const buffer = this.#terminal.buffer.active;
        const classification = classifyGraphic(protocol, sequence);
        if (classification.clearPersistent) {
            this.#persistentGraphics = [];
        }
        const graphic: TuiTerminalGraphic = {
            column: buffer.cursorX,
            line: buffer.baseY + buffer.cursorY,
            persistent: classification.persistent,
            protocol,
            revision: ++this.#graphicsRevision,
            sequence
        };
        this.#pendingGraphics.push(graphic);
        if (classification.persistent) {
            this.#persistentGraphics.push(graphic);
            this.#trimPersistentGraphics();
        }
    }

    scrollLines(amount: number): void {
        this.#terminal.scrollLines(Math.trunc(amount));
    }

    scrollPages(amount: number): void {
        this.#terminal.scrollPages(Math.trunc(amount));
    }

    scrollToBottom(): void {
        this.#terminal.scrollToBottom();
    }

    scrollToTop(): void {
        this.#terminal.scrollToTop();
    }

    sendMouse(event: TuiTerminalMouseEvent): boolean {
        const tracking = this.#terminal.modes.mouseTrackingMode;
        if (!shouldSendMouse(event, tracking) || this.#mouseUnsupported) {
            return false;
        }

        const x = clampCoordinate(event.x, this.#terminal.cols);
        const y = clampCoordinate(event.y, this.#terminal.rows);
        const sequence = this.#mouseSgr
            ? `\u001B[<${event.button};${x};${y}${event.kind === "press" ? "M" : "m"}`
            : encodeLegacyMouse(event, x, y);
        this.#terminal.input(sequence, true);
        return true;
    }

    setFocused(focused: boolean): void {
        if (this.#focused === focused) {
            return;
        }
        this.#focused = focused;
        if (this.#terminal.modes.sendFocusMode) {
            this.#terminal.input(focused ? "\u001B[I" : "\u001B[O", false);
        }
    }

    takePendingGraphics(): TuiTerminalGraphic[] {
        const pending = this.#pendingGraphics;
        this.#pendingGraphics = [];
        return pending;
    }

    write(data: string): Promise<void> {
        this.clearSelection();
        if (clearsGraphics(data)) {
            this.#clearPersistentGraphics();
        }
        return new Promise((resolve) => {
            this.#terminal.write(data, resolve);
        });
    }

    updateSelection(x: number, y: number): void {
        if (this.#selection === undefined) {
            return;
        }
        this.#selection.focus = this.#selectionPoint(x, y);
    }

    #selectionPoint(x: number, y: number): TuiTerminalSelectionPoint {
        const buffer = this.#terminal.buffer.active;
        return {
            column: Math.min(Math.max(0, Math.floor(x) - 1), Math.max(0, this.#terminal.cols - 1)),
            line: Math.min(
                Math.max(0, buffer.viewportY + Math.floor(y) - 1),
                Math.max(0, buffer.length - 1)
            )
        };
    }

    #selectionRange(line: number): readonly [number, number] | undefined {
        if (this.#selection === undefined) {
            return undefined;
        }
        const [start, end] = orderedSelection(this.#selection.anchor, this.#selection.focus);
        if (line < start.line || line > end.line) {
            return undefined;
        }
        return [
            line === start.line ? start.column : 0,
            line === end.line ? end.column + 1 : this.#terminal.cols
        ];
    }

    #clearPersistentGraphics(): void {
        if (this.#persistentGraphics.length === 0) {
            return;
        }
        this.#persistentGraphics = [];
        this.#graphicsRevision += 1;
    }

    #trimPersistentGraphics(): void {
        let bytes = this.#persistentGraphics.reduce(
            (total, graphic) => total + Buffer.byteLength(graphic.sequence, "utf8"),
            0
        );
        while (
            this.#persistentGraphics.length > MAX_PERSISTENT_GRAPHICS
            || bytes > MAX_PERSISTENT_GRAPHICS_BYTES
        ) {
            const removed = this.#persistentGraphics.shift();
            if (removed === undefined) {
                break;
            }
            bytes -= Buffer.byteLength(removed.sequence, "utf8");
        }
    }

    #updatePrivateModes(params: (number | number[])[], enabled: boolean): void {
        for (const param of params) {
            if (typeof param !== "number") {
                continue;
            }
            if (param === 1006) {
                this.#mouseSgr = enabled;
            }
            if (param === 1005 || param === 1015) {
                this.#mouseUnsupported = enabled;
            }
        }
    }
}

function classifyGraphic(
    protocol: TuiTerminalGraphicProtocol,
    sequence: string
): { clearPersistent: boolean; persistent: boolean } {
    if (protocol === "sixel") {
        return { clearPersistent: false, persistent: true };
    }

    const separator = sequence.indexOf(";");
    const header = separator === -1 ? sequence : sequence.slice(0, separator);
    const action = header
        .slice(header.indexOf("_G") + 2)
        .split(",")
        .find((part) => part.startsWith("a="))
        ?.slice(2) ?? "T";
    return {
        clearPersistent: action === "d",
        persistent: action !== "d" && action !== "q"
    };
}

function clearsGraphics(data: string): boolean {
    return data.includes("\u001B[2J")
        || data.includes("\u001B[3J")
        || data.includes("\u001B[?47h")
        || data.includes("\u001B[?47l")
        || data.includes("\u001B[?1047h")
        || data.includes("\u001B[?1047l")
        || data.includes("\u001B[?1049h")
        || data.includes("\u001B[?1049l")
        || data.includes("\u001Bc");
}

function encodeInput(
    data: string,
    modes: { applicationCursorKeys: boolean; applicationKeypad: boolean }
): string {
    const source = modes.applicationCursorKeys ? "\u001B[" : "\u001BO";
    const target = modes.applicationCursorKeys ? "\u001BO" : "\u001B[";
    let output = data;
    for (const final of "ABCDHF") {
        output = output.split(`${source}${final}`).join(`${target}${final}`);
    }
    if (!modes.applicationKeypad) {
        for (const [final, replacement] of Object.entries(KEYPAD_NORMAL_VALUES)) {
            output = output.split(`\u001BO${final}`).join(replacement);
        }
    }
    return output;
}

const KEYPAD_NORMAL_VALUES: Readonly<Record<string, string>> = {
    M: "\r",
    X: "=",
    j: "*",
    k: "+",
    l: ",",
    m: "-",
    n: ".",
    o: "/",
    p: "0",
    q: "1",
    r: "2",
    s: "3",
    t: "4",
    u: "5",
    v: "6",
    w: "7",
    x: "8",
    y: "9"
};

function orderedSelection(
    left: TuiTerminalSelectionPoint,
    right: TuiTerminalSelectionPoint
): readonly [TuiTerminalSelectionPoint, TuiTerminalSelectionPoint] {
    if (left.line < right.line || (left.line === right.line && left.column <= right.column)) {
        return [left, right];
    }
    return [right, left];
}

function shouldSendMouse(
    event: TuiTerminalMouseEvent,
    tracking: "none" | "x10" | "vt200" | "drag" | "any"
): boolean {
    if (tracking === "none") {
        return false;
    }
    if ((event.button & 64) !== 0) {
        return true;
    }
    if (event.kind === "release") {
        return tracking !== "x10";
    }
    if ((event.button & 32) === 0) {
        return true;
    }
    if (tracking === "any") {
        return true;
    }
    return tracking === "drag" && (event.button & 3) !== 3;
}

function encodeLegacyMouse(event: TuiTerminalMouseEvent, x: number, y: number): string {
    const modifiers = event.button & ~3;
    const button = event.kind === "release" ? modifiers | 3 : event.button;
    return `\u001B[M${String.fromCharCode(
        Math.min(255, button + 32),
        Math.min(255, x + 32),
        Math.min(255, y + 32)
    )}`;
}

function clampCoordinate(value: number, maximum: number): number {
    return Math.min(Math.max(1, Math.floor(value)), Math.max(1, maximum));
}

function buildSegments(
    line: IBufferLine | undefined,
    columns: number,
    cursorColumn?: number,
    selection?: readonly [number, number]
): TuiTerminalSegment[] {
    const segments: TuiTerminalSegment[] = [];

    for (let column = 0; column < columns; column += 1) {
        const cell = line?.getCell(column);
        if (cell?.getWidth() === 0) {
            continue;
        }

        const selected = selection !== undefined && column >= selection[0] && column < selection[1];
        const segment = segmentForCell(cell, column === cursorColumn || selected);
        const previous = segments.at(-1);
        if (previous !== undefined && sameStyle(previous, segment)) {
            previous.text += segment.text;
        } else {
            segments.push(segment);
        }
    }

    return segments.length === 0 ? [{ text: " ".repeat(columns) }] : segments;
}

function segmentForCell(cell: IBufferCell | undefined, cursor: boolean): TuiTerminalSegment {
    if (cell === undefined) {
        return { inverse: cursor || undefined, text: " " };
    }

    const invisible = cell.isInvisible() !== 0;
    const inverse = cell.isInverse() !== 0;
    return {
        backgroundColor: colorForCell(cell, false),
        bold: cell.isBold() !== 0 || undefined,
        color: colorForCell(cell, true),
        dimColor: cell.isDim() !== 0 || undefined,
        inverse: cursor ? !inverse : inverse || undefined,
        italic: cell.isItalic() !== 0 || undefined,
        strikethrough: cell.isStrikethrough() !== 0 || undefined,
        text: invisible ? " " : cell.getChars() || " ",
        underline: cell.isUnderline() !== 0 || undefined
    };
}

function colorForCell(cell: IBufferCell, foreground: boolean): string | undefined {
    const isDefault = foreground ? cell.isFgDefault() : cell.isBgDefault();
    if (isDefault) {
        return undefined;
    }

    const value = foreground ? cell.getFgColor() : cell.getBgColor();
    const isRgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
    if (isRgb) {
        return `#${value.toString(16).padStart(6, "0")}`;
    }

    return paletteColor(value);
}

function paletteColor(index: number): string {
    if (index < ANSI_COLORS.length) {
        return ANSI_COLORS[index] ?? "#ffffff";
    }
    if (index >= 232) {
        const level = 8 + (index - 232) * 10;
        return rgb(level, level, level);
    }

    const offset = index - 16;
    const red = Math.floor(offset / 36);
    const green = Math.floor((offset % 36) / 6);
    const blue = offset % 6;
    return rgb(cubeLevel(red), cubeLevel(green), cubeLevel(blue));
}

function cubeLevel(value: number): number {
    return value === 0 ? 0 : 55 + value * 40;
}

function rgb(red: number, green: number, blue: number): string {
    return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function sameStyle(left: TuiTerminalSegment, right: TuiTerminalSegment): boolean {
    return left.backgroundColor === right.backgroundColor
        && left.bold === right.bold
        && left.color === right.color
        && left.dimColor === right.dimColor
        && left.inverse === right.inverse
        && left.italic === right.italic
        && left.strikethrough === right.strikethrough
        && left.underline === right.underline;
}

function clampDimension(value: number): number {
    return Math.max(1, Math.floor(value));
}
