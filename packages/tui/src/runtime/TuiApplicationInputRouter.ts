import { StringDecoder } from "node:string_decoder";

export type TuiApplicationInputAction =
    | { data: string; type: "ink" }
    | {
          button: number;
          kind: "press" | "release";
          type: "mouse";
          x: number;
          y: number;
      };

const ESCAPE = "\u001B";
const MOUSE_PREFIX = `${ESCAPE}[<`;
const PASTE_BEGIN = `${ESCAPE}[200~`;
const PASTE_END = `${ESCAPE}[201~`;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
});

export class TuiApplicationInputRouter {
    #buffer = "";
    #decoder = new StringDecoder("utf8");
    #pasteBuffer?: string;

    push(chunk: string | Uint8Array): TuiApplicationInputAction[] {
        this.#buffer +=
            typeof chunk === "string"
                ? chunk
                : this.#decoder.write(Buffer.from(chunk));
        const actions: TuiApplicationInputAction[] = [];

        while (this.#buffer.length > 0) {
            if (this.#pasteBuffer !== undefined) {
                this.#pasteBuffer += this.#buffer;
                this.#buffer = "";
                const end = this.#pasteBuffer.indexOf(PASTE_END);
                if (end === -1) break;
                appendInk(actions, this.#pasteBuffer.slice(0, end));
                this.#buffer = this.#pasteBuffer.slice(end + PASTE_END.length);
                this.#pasteBuffer = undefined;
                continue;
            }

            if (this.#buffer.startsWith(PASTE_BEGIN)) {
                this.#buffer = this.#buffer.slice(PASTE_BEGIN.length);
                this.#pasteBuffer = "";
                continue;
            }
            if (PASTE_BEGIN.startsWith(this.#buffer)) break;

            const mouse = parseMouse(this.#buffer);
            if (mouse !== undefined) {
                actions.push({
                    button: mouse.button,
                    kind: mouse.kind,
                    type: "mouse",
                    x: mouse.x,
                    y: mouse.y,
                });
                this.#buffer = this.#buffer.slice(mouse.length);
                continue;
            }
            if (isPartialMouse(this.#buffer)) break;

            if (this.#buffer.startsWith(ESCAPE)) {
                const sequenceLength = escapeSequenceLength(this.#buffer);
                if (sequenceLength === undefined) break;
                actions.push({
                    data: this.#buffer.slice(0, sequenceLength),
                    type: "ink",
                });
                this.#buffer = this.#buffer.slice(sequenceLength);
                continue;
            }

            const controlIndex = firstControlIndex(this.#buffer);
            if (controlIndex === 0) {
                actions.push({ data: this.#buffer[0]!, type: "ink" });
                this.#buffer = this.#buffer.slice(1);
                continue;
            }
            const end = controlIndex === -1 ? this.#buffer.length : controlIndex;
            appendInkKeys(actions, this.#buffer.slice(0, end));
            this.#buffer = this.#buffer.slice(end);
        }

        return actions;
    }

    hasPendingEscape(): boolean {
        return this.#pasteBuffer === undefined && this.#buffer.startsWith(ESCAPE);
    }

    flushPendingEscape(): TuiApplicationInputAction[] {
        if (!this.hasPendingEscape()) return [];
        const buffered = this.#buffer;
        this.#buffer = "";
        const actions: TuiApplicationInputAction[] = [];
        let cursor = 0;
        while (buffered[cursor] === ESCAPE) {
            actions.push({ data: ESCAPE, type: "ink" });
            cursor += 1;
        }
        appendInkKeys(actions, buffered.slice(cursor));
        return actions;
    }

    reset(): void {
        this.#buffer = "";
        this.#pasteBuffer = undefined;
        this.#decoder = new StringDecoder("utf8");
    }
}

function escapeSequenceLength(value: string): number | undefined {
    if (value.length === 1) return undefined;
    const introducer = value[1]!;
    if (introducer === ESCAPE) return 1;
    if (introducer === "[") {
        for (let index = 2; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (code >= 0x40 && code <= 0x7e) return index + 1;
        }
        return undefined;
    }
    if (introducer === "O" || introducer === "N") {
        return value.length > 2 ? 3 : undefined;
    }
    return 2;
}

function firstControlIndex(value: string): number {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === 0x1b || code <= 0x1f || code === 0x7f) return index;
    }
    return -1;
}

function isPartialMouse(value: string): boolean {
    if (!value.startsWith(MOUSE_PREFIX)) return MOUSE_PREFIX.startsWith(value);
    return [...value.slice(MOUSE_PREFIX.length)].every(
        (character) => character === ";" || (character >= "0" && character <= "9"),
    );
}

function parseMouse(value: string): {
    button: number;
    kind: "press" | "release";
    length: number;
    x: number;
    y: number;
} | undefined {
    if (!value.startsWith(MOUSE_PREFIX)) return undefined;
    for (let index = MOUSE_PREFIX.length; index < value.length; index += 1) {
        const character = value[index]!;
        if (character !== "M" && character !== "m") {
            if (character !== ";" && (character < "0" || character > "9")) {
                return undefined;
            }
            continue;
        }
        const parts = value.slice(MOUSE_PREFIX.length, index).split(";");
        if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
            return undefined;
        }
        return {
            button: Number(parts[0]),
            kind: character === "M" ? "press" : "release",
            length: index + 1,
            x: Number(parts[1]),
            y: Number(parts[2]),
        };
    }
    return undefined;
}

function appendInk(actions: TuiApplicationInputAction[], data: string): void {
    if (data.length === 0) return;
    actions.push({ data, type: "ink" });
}

function appendInkKeys(actions: TuiApplicationInputAction[], data: string): void {
    for (const { segment } of GRAPHEME_SEGMENTER.segment(data)) {
        appendInk(actions, segment);
    }
}
