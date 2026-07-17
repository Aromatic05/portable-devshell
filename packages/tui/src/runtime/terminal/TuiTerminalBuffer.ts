import headless from "@xterm/headless";
import type { IBufferCell, IBufferLine, Terminal as HeadlessTerminal } from "@xterm/headless";

import type {
    TuiTerminalBufferSnapshot,
    TuiTerminalDisposable,
    TuiTerminalLine,
    TuiTerminalMouseEvent,
    TuiTerminalSegment
} from "./TuiTerminalModel.js";

const ANSI_COLORS = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"
] as const;
const { Terminal } = headless;

export class TuiTerminalBuffer {
    readonly #terminal: HeadlessTerminal;
    #focused = false;
    #mouseSgr = false;
    #mouseUnsupported = false;
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

    getSnapshot(): TuiTerminalBufferSnapshot {
        const buffer = this.#terminal.buffer.active;
        const cursor = {
            x: buffer.cursorX,
            y: buffer.baseY + buffer.cursorY - buffer.viewportY
        };
        const lines: TuiTerminalLine[] = [];

        for (let row = 0; row < this.#terminal.rows; row += 1) {
            const line = buffer.getLine(buffer.viewportY + row);
            lines.push({
                segments: buildSegments(line, this.#terminal.cols, row === cursor.y ? cursor.x : undefined)
            });
        }

        return {
            columns: this.#terminal.cols,
            cursor,
            lines,
            modes: {
                applicationCursorKeys: this.#terminal.modes.applicationCursorKeysMode,
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
            title: this.#title
        };
    }

    input(data: string): void {
        this.#terminal.input(encodeCursorKeys(data, this.#terminal.modes.applicationCursorKeysMode), true);
    }

    onData(listener: (data: string) => void): TuiTerminalDisposable {
        return this.#terminal.onData(listener);
    }

    resize(columns: number, rows: number): void {
        this.#terminal.resize(clampDimension(columns), clampDimension(rows));
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

    write(data: string): Promise<void> {
        return new Promise((resolve) => {
            this.#terminal.write(data, resolve);
        });
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

function encodeCursorKeys(data: string, applicationMode: boolean): string {
    const source = applicationMode ? "\u001B[" : "\u001BO";
    const target = applicationMode ? "\u001BO" : "\u001B[";
    let output = data;
    for (const final of "ABCDHF") {
        output = output.split(`${source}${final}`).join(`${target}${final}`);
    }
    return output;
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

function buildSegments(line: IBufferLine | undefined, columns: number, cursorColumn?: number): TuiTerminalSegment[] {
    const segments: TuiTerminalSegment[] = [];

    for (let column = 0; column < columns; column += 1) {
        const cell = line?.getCell(column);
        if (cell?.getWidth() === 0) {
            continue;
        }

        const segment = segmentForCell(cell, column === cursorColumn);
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
