import type { TuiTerminalGraphicProtocol } from "./TuiTerminalModel.js";

export type TuiTerminalOutputToken =
    | { data: string; type: "text" }
    | { data: string; protocol: TuiTerminalGraphicProtocol; type: "graphic" };

type TuiTerminalGraphicStart =
    | { incomplete: true; index: number; payloadOffset: number }
    | {
        incomplete: false;
        index: number;
        payloadOffset: number;
        protocol: TuiTerminalGraphicProtocol;
    };

const ESCAPE = "\u001B";
const KITTY_PREFIX = `${ESCAPE}_G`;
const DCS_PREFIX = `${ESCAPE}P`;
const STRING_TERMINATOR = `${ESCAPE}\\`;
const MAX_GRAPHIC_SEQUENCE_BYTES = 16 * 1024 * 1024;

export class TuiTerminalGraphicsParser {
    #buffer = "";

    flush(): TuiTerminalOutputToken[] {
        if (this.#buffer.length === 0) {
            return [];
        }
        const data = this.#buffer;
        this.#buffer = "";
        return [{ data, type: "text" }];
    }

    push(data: string): TuiTerminalOutputToken[] {
        this.#buffer += data;
        const tokens: TuiTerminalOutputToken[] = [];

        while (this.#buffer.length > 0) {
            const start = findGraphicStart(this.#buffer);
            if (start === undefined) {
                const retained = retainedSuffixLength(this.#buffer);
                const flushLength = this.#buffer.length - retained;
                if (flushLength > 0) {
                    appendText(tokens, this.#buffer.slice(0, flushLength));
                    this.#buffer = this.#buffer.slice(flushLength);
                }
                break;
            }

            if (start.incomplete) {
                if (start.index > 0) {
                    appendText(tokens, this.#buffer.slice(0, start.index));
                    this.#buffer = this.#buffer.slice(start.index);
                }
                break;
            }

            if (start.index > 0) {
                appendText(tokens, this.#buffer.slice(0, start.index));
                this.#buffer = this.#buffer.slice(start.index);
            }

            const terminator = findTerminator(this.#buffer, start.payloadOffset - start.index);
            if (terminator === undefined) {
                if (Buffer.byteLength(this.#buffer, "utf8") > MAX_GRAPHIC_SEQUENCE_BYTES) {
                    appendText(tokens, this.#buffer);
                    this.#buffer = "";
                }
                break;
            }

            const sequence = this.#buffer.slice(0, terminator.end);
            tokens.push({ data: sequence, protocol: start.protocol, type: "graphic" });
            this.#buffer = this.#buffer.slice(terminator.end);
        }

        return tokens;
    }

    reset(): void {
        this.#buffer = "";
    }
}

function findGraphicStart(value: string): TuiTerminalGraphicStart | undefined {
    const kittyIndex = value.indexOf(KITTY_PREFIX);
    let sixel: TuiTerminalGraphicStart | undefined;
    let cursor = 0;
    do {
        const index = value.indexOf(DCS_PREFIX, cursor);
        if (index === -1) {
            break;
        }
        const candidate = findSixelStart(value, index);
        if (candidate.incomplete) {
            sixel = candidate;
            break;
        }
        if (candidate.protocol === "sixel") {
            sixel = candidate;
            break;
        }
        cursor = index + DCS_PREFIX.length;
    } while (cursor < value.length);

    const candidates = [
        kittyIndex === -1
            ? undefined
            : {
                incomplete: false,
                index: kittyIndex,
                payloadOffset: kittyIndex + KITTY_PREFIX.length,
                protocol: "kitty" as const
            },
        sixel
    ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);

    return candidates.sort((left, right) => left.index - right.index)[0];
}

function findSixelStart(value: string, index: number): TuiTerminalGraphicStart | {
    incomplete: false;
    index: number;
    payloadOffset: number;
    protocol?: undefined;
} {
    for (let cursor = index + DCS_PREFIX.length; cursor < value.length; cursor += 1) {
        const code = value.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) {
            return {
                incomplete: false,
                index,
                payloadOffset: cursor + 1,
                ...(value[cursor] === "q" ? { protocol: "sixel" as const } : {})
            };
        }
    }
    return {
        incomplete: true,
        index,
        payloadOffset: value.length
    };
}

function findTerminator(value: string, offset: number): { end: number } | undefined {
    const sevenBit = value.indexOf(STRING_TERMINATOR, offset);
    const eightBit = value.indexOf("\u009C", offset);
    if (sevenBit === -1 && eightBit === -1) {
        return undefined;
    }
    if (sevenBit !== -1 && (eightBit === -1 || sevenBit < eightBit)) {
        return { end: sevenBit + STRING_TERMINATOR.length };
    }
    return { end: eightBit + 1 };
}

function retainedSuffixLength(value: string): number {
    const lastEscape = value.lastIndexOf(ESCAPE);
    if (lastEscape === -1) {
        return 0;
    }
    const suffix = value.slice(lastEscape);
    if (KITTY_PREFIX.startsWith(suffix) || suffix.startsWith(DCS_PREFIX)) {
        return suffix.length;
    }
    return 0;
}

function appendText(tokens: TuiTerminalOutputToken[], data: string): void {
    if (data.length === 0) {
        return;
    }
    const previous = tokens.at(-1);
    if (previous?.type === "text") {
        previous.data += data;
        return;
    }
    tokens.push({ data, type: "text" });
}
