import { TuiInputFramer, type TuiInputFrame } from "../TuiInputFramer.js";

export type TuiTerminalInputAction =
    | { data: string; type: "data" }
    | { type: "focus.leave" }
    | { type: "source.toggle" }
    | { data: string; type: "paste" }
    | { direction: "pageUp" | "pageDown" | "top" | "bottom"; type: "scroll" }
    | { button: number; kind: "press" | "release"; type: "mouse"; x: number; y: number };

const ESCAPE = "\u001B";
const FOCUS_LEAVE = "\u001D";
const SOURCE_TOGGLE = "\u0014";
const SCROLL_SEQUENCES = new Map<string, Extract<TuiTerminalInputAction, { type: "scroll" }>["direction"]>([
    [`${ESCAPE}[5;2~`, "pageUp"],
    [`${ESCAPE}[6;2~`, "pageDown"],
    [`${ESCAPE}[1;2H`, "top"],
    [`${ESCAPE}[1;2F`, "bottom"],
    [`${ESCAPE}[1;2~`, "top"],
    [`${ESCAPE}[4;2~`, "bottom"],
]);

export class TuiTerminalInputRouter {
    readonly #framer = new TuiInputFramer();

    push(chunk: string | Uint8Array): TuiTerminalInputAction[] {
        return projectFrames(this.#framer.push(chunk));
    }

    flushPendingEscape(): TuiTerminalInputAction[] {
        return projectFrames(this.#framer.flushPendingEscape());
    }

    hasPendingEscape(): boolean {
        return this.#framer.hasPendingEscape();
    }

    reset(): void {
        this.#framer.reset();
    }
}

export function projectTuiTerminalInputFrame(
    frame: TuiInputFrame,
): TuiTerminalInputAction {
    if (frame.type === "mouse" || frame.type === "paste") return frame;
    if (frame.data === FOCUS_LEAVE) return { type: "focus.leave" };
    if (frame.data === SOURCE_TOGGLE) return { type: "source.toggle" };
    const scroll = SCROLL_SEQUENCES.get(frame.data);
    if (scroll !== undefined) return { direction: scroll, type: "scroll" };
    return { data: frame.data, type: "data" };
}

function projectFrames(frames: readonly TuiInputFrame[]): TuiTerminalInputAction[] {
    const actions: TuiTerminalInputAction[] = [];
    for (const frame of frames) {
        appendAction(actions, projectTuiTerminalInputFrame(frame));
    }
    return actions;
}

function appendAction(
    actions: TuiTerminalInputAction[],
    action: TuiTerminalInputAction,
): void {
    const previous = actions.at(-1);
    if (previous?.type === "data" && action.type === "data") {
        previous.data += action.data;
        return;
    }
    actions.push(action);
}
