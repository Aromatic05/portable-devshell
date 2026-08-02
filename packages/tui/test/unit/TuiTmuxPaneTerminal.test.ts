import assert from "node:assert/strict";
import test from "node:test";

import {
    TUI_TMUX_MULTI_WRITER_WARNING,
    encodeTmuxInput,
    nextTuiTerminalTab,
    projectTmuxPanes,
    renderTmuxInspectView,
    routeTmuxAttachInput,
    routeTmuxPaneBrowseInput,
    scrollTmuxInspectView,
    tuiTerminalTabLabel,
    tuiTerminalTabs,
    type TuiTerminalLine,
    type TuiTmuxListPane,
} from "../../src/testing.ts";

function plainLines(values: readonly string[]): TuiTerminalLine[] {
    return values.map((text) => ({ segments: [{ text }] }));
}

function visibleText(view: { visibleLines: TuiTerminalLine[] }): string[] {
    return view.visibleLines.map((line) => line.segments.map((segment) => segment.text).join(""));
}

test("terminal page exposes a second-level selector with Instances and Tmux Panes", () => {
    assert.deepEqual([...tuiTerminalTabs], ["instances", "tmuxPanes"]);
    assert.equal(tuiTerminalTabLabel("instances"), "Instances");
    assert.equal(tuiTerminalTabLabel("tmuxPanes"), "Tmux Panes");
    assert.equal(nextTuiTerminalTab("instances"), "tmuxPanes");
    assert.equal(nextTuiTerminalTab("tmuxPanes"), "instances");
});

test("only panes whose task.status is exactly running support Attach; other tasks stay View-only", () => {
    const panes: TuiTmuxListPane[] = [
        { id: "pane-1", name: "main", status: "idle" },
        { id: "pane-2", name: "server", status: "running", task: { id: "task-9", status: "running" } },
        { id: "pane-3", name: "auto-1", status: "0" },
        { id: "pane-4", name: "done", status: "0", task: { id: "task-5", status: "0" } },
    ];
    const models = projectTmuxPanes(panes);
    assert.deepEqual(models, [
        { id: "pane-1", mode: "view", name: "main", status: "idle", taskId: undefined },
        { id: "pane-2", mode: "attach", name: "server", status: "running", taskId: "task-9" },
        { id: "pane-3", mode: "view", name: "auto-1", status: "0", taskId: undefined },
        { id: "pane-4", mode: "view", name: "done", status: "0", taskId: "task-5" },
    ]);
});

test("View renders tmux_inspect lines with clamped, scrollable offsets", () => {
    const lines = plainLines(["one", "two", "three", "four", "five"]);

    const top = renderTmuxInspectView(lines, 3, 0);
    assert.deepEqual(visibleText(top), ["one", "two", "three"]);
    assert.equal(top.offset, 0);
    assert.equal(top.atBottom, false);
    assert.equal(top.totalLines, 5);

    const middle = renderTmuxInspectView(lines, 3, 1);
    assert.deepEqual(visibleText(middle), ["two", "three", "four"]);
    assert.equal(middle.atBottom, false);

    const clamped = renderTmuxInspectView(lines, 3, 99);
    assert.deepEqual(visibleText(clamped), ["three", "four", "five"]);
    assert.equal(clamped.offset, 2);
    assert.equal(clamped.atBottom, true);

    const negative = renderTmuxInspectView(lines, 3, -5);
    assert.equal(negative.offset, 0);

    const scrolled = scrollTmuxInspectView(lines, 3, 0, 1);
    assert.deepEqual(visibleText(scrolled), ["two", "three", "four"]);
    const scrolledBack = scrollTmuxInspectView(lines, 3, 1, -1);
    assert.deepEqual(visibleText(scrolledBack), ["one", "two", "three"]);
});

test("View stays scrollable when content is shorter than the viewport", () => {
    const view = renderTmuxInspectView(plainLines(["only"]), 10, 0);
    assert.deepEqual(visibleText(view), ["only"]);
    assert.equal(view.offset, 0);
    assert.equal(view.atBottom, true);
});

test("Attach warning states per-pane mutex serialization with nondeterministic cross-client batch ordering", () => {
    const warning = TUI_TMUX_MULTI_WRITER_WARNING.toLowerCase();
    assert.equal(warning.includes("tmux_input"), true);
    assert.equal(warning.includes("atomically"), true);
    assert.equal(warning.includes("serialize"), true);
    assert.equal(warning.includes("mutex"), true);
    assert.equal(warning.includes("nondeterministic"), true);
    assert.equal(warning.includes("uncoordinated"), true);
    assert.equal(warning.includes("interleave"), false);
    assert.equal(warning.includes("ctrl+["), true);
    assert.equal(warning.includes("no lock"), false);
});

test("Ctrl+[ exits Attach instead of being forwarded to tmux_input", () => {
    assert.deepEqual(routeTmuxAttachInput("\u001b"), { kind: "exit" });
});

test("Attach forwards ordinary input to tmux_input using caret notation", () => {
    assert.deepEqual(routeTmuxAttachInput("hello"), { input: "hello", kind: "send" });
    assert.deepEqual(routeTmuxAttachInput("\r"), { input: "^M", kind: "send" });
    assert.deepEqual(routeTmuxAttachInput("\n"), { input: "^M", kind: "send" });
    assert.deepEqual(routeTmuxAttachInput("\u0003"), { input: "^C", kind: "send" });
    assert.deepEqual(routeTmuxAttachInput("\u0004"), { input: "^D", kind: "send" });
    assert.deepEqual(routeTmuxAttachInput("\t"), { input: "^I", kind: "send" });
});

test("Attach escapes literal carets and preserves escape sequences for tmux_input", () => {
    assert.equal(encodeTmuxInput("a^b"), "a^^b");
    assert.equal(encodeTmuxInput("\u001b[A"), "^[[A");
    assert.deepEqual(routeTmuxAttachInput("\u001b[A"), { input: "^[[A", kind: "send" });
});

test("Attach ignores input that carries no deliverable bytes", () => {
    assert.deepEqual(routeTmuxAttachInput("\u0000"), { kind: "noop" });
});

test("list browsing maps arrows and vi keys to selection, Enter to activate, Esc to close", () => {
    assert.deepEqual(routeTmuxPaneBrowseInput("\u001b[B", "list"), { direction: "next", kind: "select" });
    assert.deepEqual(routeTmuxPaneBrowseInput("j", "list"), { direction: "next", kind: "select" });
    assert.deepEqual(routeTmuxPaneBrowseInput("\u001b[A", "list"), { direction: "previous", kind: "select" });
    assert.deepEqual(routeTmuxPaneBrowseInput("k", "list"), { direction: "previous", kind: "select" });
    assert.deepEqual(routeTmuxPaneBrowseInput("\r", "list"), { kind: "activate" });
    assert.deepEqual(routeTmuxPaneBrowseInput("\u001b", "list"), { kind: "close" });
    assert.deepEqual(routeTmuxPaneBrowseInput("x", "list"), { kind: "noop" });
});

test("view browsing maps arrows and vi keys to scrolling and Esc to close, not selection", () => {
    assert.deepEqual(routeTmuxPaneBrowseInput("\u001b[B", "view"), { delta: 1, kind: "scroll" });
    assert.deepEqual(routeTmuxPaneBrowseInput("j", "view"), { delta: 1, kind: "scroll" });
    assert.deepEqual(routeTmuxPaneBrowseInput("\u001b[A", "view"), { delta: -1, kind: "scroll" });
    assert.deepEqual(routeTmuxPaneBrowseInput("k", "view"), { delta: -1, kind: "scroll" });
    assert.deepEqual(routeTmuxPaneBrowseInput("\u001b", "view"), { kind: "close" });
    assert.deepEqual(routeTmuxPaneBrowseInput("\r", "view"), { kind: "noop" });
});
