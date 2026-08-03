import type { TuiTerminalTab } from "../../../state/route/TuiRoute.js";
import type { TuiTerminalLine } from "../../../runtime/terminal/TuiTerminalModel.js";

export const tuiTerminalTabs: readonly TuiTerminalTab[] = ["instances", "tmuxPanes"];
export const TUI_TMUX_INSPECT_MAX_LINES = 200;

export function tuiTerminalTabLabel(tab: TuiTerminalTab): string {
    return tab === "instances" ? "Instances" : "Tmux Panes";
}

export function nextTuiTerminalTab(tab: TuiTerminalTab): TuiTerminalTab {
    return tab === "instances" ? "tmuxPanes" : "instances";
}

export interface TuiTmuxListPane {
    id: string;
    name: string;
    status: string;
    task?: { id: string; status: string };
}

export type TuiTmuxPaneMode = "view" | "attach";

export interface TuiTmuxPaneViewModel {
    id: string;
    mode: TuiTmuxPaneMode;
    name: string;
    status: string;
    taskId?: string;
}

export function projectTmuxPanes(panes: readonly TuiTmuxListPane[]): TuiTmuxPaneViewModel[] {
    return panes.map((pane) => {
        const task = pane.task;
        return {
            id: pane.id,
            mode: task !== undefined && task.status === "running" ? "attach" : "view",
            name: pane.name,
            status: pane.status,
            taskId: task?.id,
        };
    });
}

export interface TuiTmuxScrollView {
    atBottom: boolean;
    offset: number;
    totalLines: number;
    visibleLines: TuiTerminalLine[];
}

export function renderTmuxInspectView(
    lines: readonly TuiTerminalLine[],
    viewportRows: number,
    offset: number
): TuiTmuxScrollView {
    const total = lines.length;
    const rows = Math.max(0, Math.floor(viewportRows));
    const maxOffset = Math.max(0, total - rows);
    const clamped = Math.min(Math.max(0, Math.floor(offset)), maxOffset);
    return {
        atBottom: clamped >= maxOffset,
        offset: clamped,
        totalLines: total,
        visibleLines: lines.slice(clamped, clamped + rows),
    };
}

export function scrollTmuxInspectView(
    lines: readonly TuiTerminalLine[],
    viewportRows: number,
    offset: number,
    delta: number
): TuiTmuxScrollView {
    return renderTmuxInspectView(lines, viewportRows, offset + delta);
}

export const TUI_TMUX_MULTI_WRITER_WARNING =
    "Attached via tmux_input. The pane mutex atomically serializes each input batch; when multiple clients write concurrently, batch order is nondeterministic, so shell command order is uncoordinated. Esc exits Attach.";

export type TuiTmuxAttachAction =
    | { kind: "exit" }
    | { kind: "noop" }
    | { input: string; kind: "send" };

export function routeTmuxAttachInput(raw: string): TuiTmuxAttachAction {
    if (raw === "\u001b") {
        return { kind: "exit" };
    }
    const input = encodeTmuxInput(raw);
    if (input === "") {
        return { kind: "noop" };
    }
    return { input, kind: "send" };
}

export type TuiTmuxPaneBrowseMode = "list" | "view";

export type TuiTmuxPaneBrowseAction =
    | { kind: "activate" }
    | { kind: "close" }
    | { kind: "noop" }
    | { delta: number; kind: "scroll" }
    | { direction: "next" | "previous"; kind: "select" };

export function routeTmuxPaneBrowseInput(raw: string, mode: TuiTmuxPaneBrowseMode): TuiTmuxPaneBrowseAction {
    if (mode === "view") {
        if (raw === "\u001b[A" || raw === "k") return { delta: -1, kind: "scroll" };
        if (raw === "\u001b[B" || raw === "j") return { delta: 1, kind: "scroll" };
        if (raw === "\u001b[D" || raw === "h") return { direction: "previous", kind: "select" };
        if (raw === "\u001b[C" || raw === "l") return { direction: "next", kind: "select" };
        if (raw === "\r" || raw === "\n") return { kind: "activate" };
        if (raw === "\u001b") return { kind: "close" };
        return { kind: "noop" };
    }
    if (raw === "\u001b[A" || raw === "k") return { direction: "previous", kind: "select" };
    if (raw === "\u001b[B" || raw === "j") return { direction: "next", kind: "select" };
    if (raw === "\r" || raw === "\n") return { kind: "activate" };
    if (raw === "\u001b") return { kind: "close" };
    return { kind: "noop" };
}

export function encodeTmuxInput(raw: string): string {
    let out = "";
    for (const ch of raw) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === "^") {
            out += "^^";
        } else if (ch === "\r" || ch === "\n") {
            out += "^M";
        } else if (code === 0x1b) {
            out += "^[";
        } else if (code === 0x7f) {
            out += "^?";
        } else if (code >= 0x01 && code <= 0x1a) {
            out += `^${String.fromCharCode(0x40 + code)}`;
        } else if (code < 0x20) {
            continue;
        } else {
            out += ch;
        }
    }
    return out;
}
