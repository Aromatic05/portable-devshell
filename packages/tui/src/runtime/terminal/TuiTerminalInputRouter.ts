export type TuiTerminalInputAction =
    | { data: string; type: "data" }
    | { type: "focus.leave" }
    | { data: string; type: "paste" }
    | { direction: "pageUp" | "pageDown" | "top" | "bottom"; type: "scroll" }
    | { button: number; kind: "press" | "release"; type: "mouse"; x: number; y: number };

const ESCAPE = "\u001B";
const FOCUS_LEAVE = "\u001D";
const MOUSE_PREFIX = `${ESCAPE}[<`;
const PASTE_BEGIN = `${ESCAPE}[200~`;
const PASTE_END = `${ESCAPE}[201~`;
const SCROLL_SEQUENCES = new Map<string, Extract<TuiTerminalInputAction, { type: "scroll" }>["direction"]>([
    [`${ESCAPE}[5;2~`, "pageUp"],
    [`${ESCAPE}[6;2~`, "pageDown"],
    [`${ESCAPE}[1;2H`, "top"],
    [`${ESCAPE}[1;2F`, "bottom"],
    [`${ESCAPE}[1;2~`, "top"],
    [`${ESCAPE}[4;2~`, "bottom"]
]);

export class TuiTerminalInputRouter {
    #buffer = "";
    #pasteBuffer?: string;

    push(chunk: string): TuiTerminalInputAction[] {
        this.#buffer += chunk;
        const actions: TuiTerminalInputAction[] = [];

        while (this.#buffer.length > 0) {
            if (this.#pasteBuffer !== undefined) {
                this.#pasteBuffer += this.#buffer;
                this.#buffer = "";
                const end = this.#pasteBuffer.indexOf(PASTE_END);
                if (end === -1) {
                    break;
                }
                actions.push({ data: this.#pasteBuffer.slice(0, end), type: "paste" });
                this.#buffer = this.#pasteBuffer.slice(end + PASTE_END.length);
                this.#pasteBuffer = undefined;
                continue;
            }

            if (this.#buffer.startsWith(FOCUS_LEAVE)) {
                actions.push({ type: "focus.leave" });
                this.#buffer = this.#buffer.slice(FOCUS_LEAVE.length);
                continue;
            }

            if (this.#buffer.startsWith(PASTE_BEGIN)) {
                this.#buffer = this.#buffer.slice(PASTE_BEGIN.length);
                this.#pasteBuffer = "";
                continue;
            }

            if (!this.#buffer.startsWith(ESCAPE)) {
                const nextControl = firstControlIndex(this.#buffer);
                const end = nextControl === -1 ? this.#buffer.length : nextControl;
                appendData(actions, this.#buffer.slice(0, end));
                this.#buffer = this.#buffer.slice(end);
                continue;
            }

            const mouse = parseMouse(this.#buffer);
            if (mouse !== null) {
                actions.push({
                    button: mouse.button,
                    kind: mouse.kind,
                    type: "mouse",
                    x: mouse.x,
                    y: mouse.y
                });
                this.#buffer = this.#buffer.slice(mouse.length);
                continue;
            }

            const scroll = [...SCROLL_SEQUENCES.entries()].find(([sequence]) => this.#buffer.startsWith(sequence));
            if (scroll !== undefined) {
                actions.push({ direction: scroll[1], type: "scroll" });
                this.#buffer = this.#buffer.slice(scroll[0].length);
                continue;
            }

            if (isRecognizedPartial(this.#buffer)) {
                break;
            }

            appendData(actions, ESCAPE);
            this.#buffer = this.#buffer.slice(ESCAPE.length);
        }

        return actions;
    }

    reset(): void {
        this.#buffer = "";
        this.#pasteBuffer = undefined;
    }
}

function firstControlIndex(value: string): number {
    const escape = value.indexOf(ESCAPE);
    const focusLeave = value.indexOf(FOCUS_LEAVE);
    if (escape === -1) return focusLeave;
    if (focusLeave === -1) return escape;
    return Math.min(escape, focusLeave);
}

function isRecognizedPartial(value: string): boolean {
    if ([...SCROLL_SEQUENCES.keys()].some((sequence) => sequence.startsWith(value))) {
        return true;
    }
    if (PASTE_BEGIN.startsWith(value)) {
        return true;
    }
    if (value === ESCAPE || value === `${ESCAPE}[`) {
        return true;
    }
    if (!value.startsWith(MOUSE_PREFIX)) {
        return false;
    }
    return [...value.slice(3)].every((character) => character === ";" || (character >= "0" && character <= "9"));
}

function parseMouse(value: string): {
    button: number;
    kind: "press" | "release";
    length: number;
    x: number;
    y: number;
} | null {
    if (!value.startsWith(MOUSE_PREFIX)) {
        return null;
    }

    let finalIndex = -1;
    for (let index = MOUSE_PREFIX.length; index < value.length; index += 1) {
        const character = value[index]!;
        if (character === "M" || character === "m") {
            finalIndex = index;
            break;
        }
        if (character !== ";" && (character < "0" || character > "9")) {
            return null;
        }
    }
    if (finalIndex === -1) {
        return null;
    }

    const parts = value.slice(MOUSE_PREFIX.length, finalIndex).split(";");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        return null;
    }
    return {
        button: Number(parts[0]),
        kind: value[finalIndex] === "M" ? "press" : "release",
        length: finalIndex + 1,
        x: Number(parts[1]),
        y: Number(parts[2])
    };
}

function appendData(actions: TuiTerminalInputAction[], data: string): void {
    if (data.length === 0) {
        return;
    }
    const previous = actions.at(-1);
    if (previous?.type === "data") {
        previous.data += data;
        return;
    }
    actions.push({ data, type: "data" });
}
