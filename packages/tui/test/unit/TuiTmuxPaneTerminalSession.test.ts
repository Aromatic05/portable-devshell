import assert from "node:assert/strict";
import test from "node:test";

import type { TuiTmuxInspectPane, TuiTmuxInputResult } from "../../src/runtime/operation/TuiRuntimeTmuxOperations.ts";
import {
    TuiTmuxPaneTerminalSession,
    type TuiTmuxPaneTerminalOperations,
    type TuiTmuxPaneTerminalScheduler,
} from "../../src/runtime/terminal/TuiTmuxPaneTerminalSession.ts";
import { TUI_TMUX_MULTI_WRITER_WARNING, type TuiTmuxListPane } from "../../src/testing.ts";

interface RecordedOperation {
    args: readonly unknown[];
    method: "inspectPane" | "listPanes" | "sendInput";
}

function createOperationsHarness() {
    const calls: RecordedOperation[] = [];
    const inspectByPane = new Map<string, TuiTmuxInspectPane>();
    const inputResponses: TuiTmuxInputResult[] = [];
    let panes: TuiTmuxListPane[] = [];
    const operations: TuiTmuxPaneTerminalOperations = {
        async inspectPane(instance, pane) {
            calls.push({ args: [instance, pane], method: "inspectPane" });
            return inspectByPane.get(pane);
        },
        async listPanes(instance) {
            calls.push({ args: [instance], method: "listPanes" });
            return panes;
        },
        async sendInput(instance, task, input) {
            calls.push({ args: [instance, task, input], method: "sendInput" });
            return inputResponses.shift() ?? { output: [], status: "running", task };
        },
    };
    return {
        calls,
        inspectByPane,
        inputResponses,
        operations,
        setPanes(next: TuiTmuxListPane[]) {
            panes = next;
        },
    };
}

function createManualScheduler() {
    let listener: (() => void) | undefined;
    let active = false;
    const scheduler: TuiTmuxPaneTerminalScheduler = {
        setInterval(next) {
            listener = next;
            active = true;
            return () => {
                active = false;
                listener = undefined;
            };
        },
    };
    return {
        get active() {
            return active;
        },
        scheduler,
        tick() {
            listener?.();
        },
    };
}

async function flush(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

const runningPane: TuiTmuxListPane = { id: "%1", name: "server", status: "running", task: { id: "task-9", status: "running" } };
const idlePane: TuiTmuxListPane = { id: "%0", name: "main", status: "idle" };

test("bind lists panes, projects them, and defaults the selection to the first pane", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([idlePane, runningPane]);
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });

    await session.bind("alpha");

    assert.deepEqual(harness.calls, [{ args: ["alpha"], method: "listPanes" }]);
    const snapshot = session.getSnapshot();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.instance, "alpha");
    assert.equal(snapshot.selectedIndex, 0);
    assert.deepEqual(snapshot.panes, [
        { id: "%0", mode: "view", name: "main", status: "idle", taskId: undefined },
        { id: "%1", mode: "attach", name: "server", status: "running", taskId: "task-9" },
    ]);
});

test("selection moves within bounds and clamps at the edges", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([idlePane, runningPane]);
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");

    session.selectNext();
    assert.equal(session.getSnapshot().selectedIndex, 1);
    session.selectNext();
    assert.equal(session.getSnapshot().selectedIndex, 1);
    session.selectPrevious();
    assert.equal(session.getSnapshot().selectedIndex, 0);
    session.selectPrevious();
    assert.equal(session.getSnapshot().selectedIndex, 0);
    session.selectIndex(99);
    assert.equal(session.getSnapshot().selectedIndex, 1);
});

test("activating a view-only pane opens an unattached panel without a warning", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([idlePane]);
    harness.inspectByPane.set("%0", { id: "%0", lines: ["one", "two"], name: "main", status: "idle" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations, viewportRows: 5 });
    await session.bind("alpha");

    await session.activate();

    const active = session.getSnapshot().active;
    assert.equal(active?.attached, false);
    assert.equal(active?.warning, undefined);
    assert.equal(active?.name, "main");
    assert.deepEqual(active?.lines, ["one", "two"]);
    assert.equal(harness.calls.some((call) => call.method === "inspectPane" && call.args[1] === "%0"), true);
});

test("activating a running pane attaches and surfaces the multi-writer warning", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", { id: "%1", lines: ["ready"], name: "server", status: "running", taskId: "task-9", taskStatus: "running" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");

    await session.activate();

    const active = session.getSnapshot().active;
    assert.equal(active?.attached, true);
    assert.equal(active?.taskId, "task-9");
    assert.equal(active?.warning, TUI_TMUX_MULTI_WRITER_WARNING);
});

test("attached input is encoded and forwarded to the selected running task id", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", { id: "%1", lines: [], name: "server", status: "running", taskId: "task-9", taskStatus: "running" });
    harness.inputResponses.push({ output: ["hello"], status: "running", task: "task-9" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");
    await session.activate();

    await session.handleInput("hello\r");

    assert.deepEqual(
        harness.calls.find((call) => call.method === "sendInput"),
        { args: ["alpha", "task-9", "hello^M"], method: "sendInput" },
    );
    const active = session.getSnapshot().active;
    assert.deepEqual(active?.lines, ["hello"]);
    assert.equal(active?.attached, true);
});

test("Ctrl+[ exits Attach without forwarding to tmux_input", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", { id: "%1", lines: [], name: "server", status: "running", taskId: "task-9", taskStatus: "running" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");
    await session.activate();

    await session.handleInput("\u001b");

    assert.equal(harness.calls.some((call) => call.method === "sendInput"), false);
    const active = session.getSnapshot().active;
    assert.equal(active?.attached, false);
    assert.equal(active?.warning, undefined);
});

test("raw input is ignored while viewing a pane that has no running task", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([idlePane]);
    harness.inspectByPane.set("%0", { id: "%0", lines: [], name: "main", status: "idle" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");
    await session.activate();

    await session.handleInput("hello");

    assert.equal(harness.calls.some((call) => call.method === "sendInput"), false);
});

test("View opens anchored to the latest output and scrolling up pauses follow", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([idlePane]);
    harness.inspectByPane.set("%0", { id: "%0", lines: ["a", "b", "c", "d", "e"], name: "main", status: "idle" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations, viewportRows: 2 });
    await session.bind("alpha");
    await session.activate();

    assert.deepEqual(session.getSnapshot().active?.scroll.visibleLines, ["d", "e"]);
    assert.equal(session.getSnapshot().active?.scroll.atBottom, true);

    session.scroll(-1);
    assert.deepEqual(session.getSnapshot().active?.scroll.visibleLines, ["c", "d"]);
    assert.equal(session.getSnapshot().active?.scroll.atBottom, false);

    session.scroll(-10);
    assert.equal(session.getSnapshot().active?.scroll.offset, 0);
    assert.deepEqual(session.getSnapshot().active?.scroll.visibleLines, ["a", "b"]);

    session.scroll(1_000_000);
    assert.equal(session.getSnapshot().active?.scroll.atBottom, true);
    assert.deepEqual(session.getSnapshot().active?.scroll.visibleLines, ["d", "e"]);
});

test("refresh keeps following the bottom when anchored and holds position after scrolling up", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([idlePane]);
    harness.inspectByPane.set("%0", { id: "%0", lines: ["a", "b", "c"], name: "main", status: "idle" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations, viewportRows: 2 });
    await session.bind("alpha");
    await session.activate();
    assert.equal(session.getSnapshot().active?.scroll.atBottom, true);

    harness.inspectByPane.set("%0", { id: "%0", lines: ["a", "b", "c", "d", "e"], name: "main", status: "idle" });
    await session.refresh();
    assert.equal(session.getSnapshot().active?.scroll.atBottom, true);
    assert.deepEqual(session.getSnapshot().active?.scroll.visibleLines, ["d", "e"]);

    session.scroll(-2);
    assert.equal(session.getSnapshot().active?.scroll.atBottom, false);
    const pausedOffset = session.getSnapshot().active?.scroll.offset;

    harness.inspectByPane.set("%0", { id: "%0", lines: ["a", "b", "c", "d", "e", "f", "g"], name: "main", status: "idle" });
    await session.refresh();
    assert.equal(session.getSnapshot().active?.scroll.atBottom, false);
    assert.equal(session.getSnapshot().active?.scroll.offset, pausedOffset);
});

test("a task that exits in response to input detaches and clears the warning", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", { id: "%1", lines: [], name: "server", status: "running", taskId: "task-9", taskStatus: "running" });
    harness.inputResponses.push({ output: ["bye"], status: "0", task: "task-9" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");
    await session.activate();

    await session.handleInput("\u0004");

    const active = session.getSnapshot().active;
    assert.equal(active?.attached, false);
    assert.equal(active?.warning, undefined);
    assert.equal(active?.status, "0");
});

test("refresh clears the active panel when the pane disappears from the worker", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([idlePane, runningPane]);
    harness.inspectByPane.set("%0", { id: "%0", lines: ["x"], name: "main", status: "idle" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");
    await session.activate();
    assert.notEqual(session.getSnapshot().active, undefined);

    harness.setPanes([runningPane]);
    await session.refresh();

    assert.equal(session.getSnapshot().active, undefined);
    assert.equal(session.getSnapshot().panes.length, 1);
});

test("refresh detaches when the attached task is no longer running", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", { id: "%1", lines: [], name: "server", status: "running", taskId: "task-9", taskStatus: "running" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");
    await session.activate();
    assert.equal(session.getSnapshot().active?.attached, true);

    harness.setPanes([{ id: "%1", name: "server", status: "0", task: { id: "task-9", status: "0" } }]);
    harness.inspectByPane.set("%1", { id: "%1", lines: ["done"], name: "server", status: "0", taskId: "task-9", taskStatus: "0" });
    await session.refresh();

    const active = session.getSnapshot().active;
    assert.equal(active?.attached, false);
    assert.equal(active?.warning, undefined);
    assert.equal(active?.status, "0");
});

test("polling is bounded: it refreshes per tick and stops after maxTicks", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([idlePane]);
    const scheduler = createManualScheduler();
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations, scheduler: scheduler.scheduler });
    await session.bind("alpha");
    const listCallsAfterBind = harness.calls.filter((call) => call.method === "listPanes").length;

    session.startPolling(50, 2);
    assert.equal(scheduler.active, true);

    scheduler.tick();
    await flush();
    scheduler.tick();
    await flush();

    assert.equal(scheduler.active, false);
    const listCallsAfterPolling = harness.calls.filter((call) => call.method === "listPanes").length;
    assert.equal(listCallsAfterPolling - listCallsAfterBind, 2);

    scheduler.tick();
    await flush();
    assert.equal(harness.calls.filter((call) => call.method === "listPanes").length, listCallsAfterPolling);
});

test("dispose stops polling and ignores undeliverable input", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", { id: "%1", lines: [], name: "server", status: "running", taskId: "task-9", taskStatus: "running" });
    const scheduler = createManualScheduler();
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations, scheduler: scheduler.scheduler });
    await session.bind("alpha");
    session.startPolling(50);
    assert.equal(scheduler.active, true);

    session.dispose();

    assert.equal(scheduler.active, false);
    await session.handleInput("\u0000");
    assert.equal(harness.calls.some((call) => call.method === "sendInput"), false);
});

test("handleRawInput in list mode selects with arrows and activates with Enter", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([idlePane, runningPane]);
    harness.inspectByPane.set("%1", { id: "%1", lines: ["ready"], name: "server", status: "running", taskId: "task-9", taskStatus: "running" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");

    await session.handleRawInput("\u001b[B");
    assert.equal(session.getSnapshot().selectedIndex, 1);

    await session.handleRawInput("\r");
    const active = session.getSnapshot().active;
    assert.equal(active?.name, "server");
    assert.equal(active?.attached, true);
});

test("handleRawInput in view mode scrolls up from the bottom and closes with Esc", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([idlePane]);
    harness.inspectByPane.set("%0", { id: "%0", lines: ["a", "b", "c"], name: "main", status: "idle" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations, viewportRows: 2 });
    await session.bind("alpha");
    await session.handleRawInput("\r");
    assert.deepEqual(session.getSnapshot().active?.scroll.visibleLines, ["b", "c"]);
    assert.equal(session.getSnapshot().active?.scroll.atBottom, true);

    await session.handleRawInput("\u001b[A");
    assert.deepEqual(session.getSnapshot().active?.scroll.visibleLines, ["a", "b"]);
    assert.equal(session.getSnapshot().active?.scroll.atBottom, false);

    await session.handleRawInput("\u001b");
    assert.equal(session.getSnapshot().active, undefined);
});

test("handleRawInput in attach mode forwards input and exits on Ctrl+[ without forwarding", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", { id: "%1", lines: [], name: "server", status: "running", taskId: "task-9", taskStatus: "running" });
    harness.inputResponses.push({ output: ["hi"], status: "running", task: "task-9" });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");
    await session.handleRawInput("\r");
    assert.equal(session.getSnapshot().active?.attached, true);

    await session.handleRawInput("hi\r");
    assert.deepEqual(
        harness.calls.find((call) => call.method === "sendInput"),
        { args: ["alpha", "task-9", "hi^M"], method: "sendInput" },
    );

    await session.handleRawInput("\u001b");
    assert.equal(session.getSnapshot().active?.attached, false);
    assert.equal(harness.calls.filter((call) => call.method === "sendInput").length, 1);
});

test("activation stays View-only when inspect reports that the listed task already exited", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", {
        id: "%1",
        lines: ["done"],
        name: "server",
        status: "0",
        taskId: "task-9",
        taskStatus: "0",
    });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");

    await session.activate();

    const active = session.getSnapshot().active;
    assert.equal(active?.attached, false);
    assert.equal(active?.taskId, undefined);
    assert.equal(active?.warning, undefined);
});

test("refresh converts an inspect failure into session error state without rejecting", async () => {
    let inspectFails = false;
    const operations: TuiTmuxPaneTerminalOperations = {
        async inspectPane() {
            if (inspectFails) throw new Error("inspect unavailable");
            return {
                id: "%1",
                lines: ["ready"],
                name: "server",
                status: "running",
                taskId: "task-9",
                taskStatus: "running",
            };
        },
        async listPanes() {
            return [runningPane];
        },
        async sendInput(_instance, task) {
            return { output: [], status: "running", task };
        },
    };
    const session = new TuiTmuxPaneTerminalSession({ operations });
    await session.bind("alpha");
    await session.activate();
    inspectFails = true;

    await assert.doesNotReject(session.refresh());

    assert.equal(session.getSnapshot().status, "error");
    assert.equal(session.getSnapshot().error, "inspect unavailable");
});

test("Attach serializes input batches submitted by the same TUI client", async () => {
    const calls: string[] = [];
    const resolvers: Array<(value: TuiTmuxInputResult) => void> = [];
    const operations: TuiTmuxPaneTerminalOperations = {
        async inspectPane() {
            return {
                id: "%1",
                lines: [],
                name: "server",
                status: "running",
                taskId: "task-9",
                taskStatus: "running",
            };
        },
        async listPanes() {
            return [runningPane];
        },
        async sendInput(_instance, task, input) {
            calls.push(input);
            return await new Promise<TuiTmuxInputResult>((resolve) => {
                resolvers.push(resolve);
            });
        },
    };
    const session = new TuiTmuxPaneTerminalSession({ operations });
    await session.bind("alpha");
    await session.activate();

    const first = session.handleInput("first\r");
    const second = session.handleInput("second\r");
    await flush();
    assert.deepEqual(calls, ["first^M"]);

    resolvers.shift()?.({ output: ["first"], status: "running", task: "task-9" });
    await flush();
    assert.deepEqual(calls, ["first^M", "second^M"]);

    resolvers.shift()?.({ output: ["second"], status: "running", task: "task-9" });
    await Promise.all([first, second]);
});

test("dispose prevents later input from reaching the worker", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", {
        id: "%1",
        lines: [],
        name: "server",
        status: "running",
        taskId: "task-9",
        taskStatus: "running",
    });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");
    await session.activate();

    session.dispose();
    await session.handleInput("late\r");

    assert.equal(harness.calls.some((call) => call.method === "sendInput"), false);
});

test("rebinding during an in-flight refresh immediately loads the new instance", async () => {
    let resolveAlpha: ((panes: TuiTmuxListPane[]) => void) | undefined;
    const operations: TuiTmuxPaneTerminalOperations = {
        async inspectPane() {
            return undefined;
        },
        async listPanes(instance) {
            if (instance === "alpha") {
                return await new Promise<TuiTmuxListPane[]>((resolve) => {
                    resolveAlpha = resolve;
                });
            }
            return [{ id: "%2", name: "beta-pane", status: "idle" }];
        },
        async sendInput(_instance, task) {
            return { output: [], status: "running", task };
        },
    };
    const session = new TuiTmuxPaneTerminalSession({ operations });
    const alpha = session.bind("alpha");
    await flush();

    const beta = session.bind("beta");
    await beta;

    assert.equal(session.getSnapshot().instance, "beta");
    assert.equal(session.getSnapshot().status, "ready");
    assert.equal(session.getSnapshot().panes[0]?.name, "beta-pane");

    resolveAlpha?.([]);
    await alpha;
    assert.equal(session.getSnapshot().instance, "beta");
    assert.equal(session.getSnapshot().panes[0]?.name, "beta-pane");
});

test("session inspects the selected pane by stable id when pane names are duplicated", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([
        { id: "%1", name: "duplicate", status: "idle" },
        { id: "%2", name: "duplicate", status: "running", task: { id: "task-2", status: "running" } },
    ]);
    harness.inspectByPane.set("%2", {
        id: "%2",
        lines: ["target"],
        name: "duplicate",
        status: "running",
        taskId: "task-2",
        taskStatus: "running",
    });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");
    session.selectIndex(1);

    await session.activate();

    assert.deepEqual(
        harness.calls.find((call) => call.method === "inspectPane"),
        { args: ["alpha", "%2"], method: "inspectPane" },
    );
    assert.equal(session.getSnapshot().active?.paneId, "%2");
    assert.equal(session.getSnapshot().active?.attached, true);
});

test("activation attaches to a fresh running task that replaced the listed task on the same pane", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", {
        id: "%1",
        lines: ["new task"],
        name: "server",
        status: "running",
        taskId: "task-new",
        taskStatus: "running",
    });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");

    await session.activate();

    assert.equal(session.getSnapshot().active?.attached, true);
    assert.equal(session.getSnapshot().active?.taskId, "task-new");
});

test("a stale polling inspect cannot overwrite output returned by tmux_input", async () => {
    let inspectCount = 0;
    let resolveStaleInspect: ((detail: TuiTmuxInspectPane | undefined) => void) | undefined;
    const operations: TuiTmuxPaneTerminalOperations = {
        async inspectPane() {
            inspectCount += 1;
            if (inspectCount === 1) {
                return {
                    id: "%1",
                    lines: [],
                    name: "server",
                    status: "running",
                    taskId: "task-9",
                    taskStatus: "running",
                };
            }
            return await new Promise<TuiTmuxInspectPane | undefined>((resolve) => {
                resolveStaleInspect = resolve;
            });
        },
        async listPanes() {
            return [runningPane];
        },
        async sendInput(_instance, task) {
            return { output: ["fresh output"], status: "running", task };
        },
    };
    const session = new TuiTmuxPaneTerminalSession({ operations });
    await session.bind("alpha");
    await session.activate();

    const refresh = session.refresh();
    await flush();
    await session.handleInput("echo fresh\r");
    assert.deepEqual(session.getSnapshot().active?.lines, ["fresh output"]);

    resolveStaleInspect?.({
        id: "%1",
        lines: ["stale output"],
        name: "server",
        status: "running",
        taskId: "task-9",
        taskStatus: "running",
    });
    await refresh;

    assert.deepEqual(session.getSnapshot().active?.lines, ["fresh output"]);
});

test("refresh detaches instead of silently switching an Attach session to a replacement task", async () => {
    const harness = createOperationsHarness();
    harness.setPanes([runningPane]);
    harness.inspectByPane.set("%1", {
        id: "%1",
        lines: [],
        name: "server",
        status: "running",
        taskId: "task-9",
        taskStatus: "running",
    });
    const session = new TuiTmuxPaneTerminalSession({ operations: harness.operations });
    await session.bind("alpha");
    await session.activate();
    assert.equal(session.getSnapshot().active?.attached, true);

    harness.setPanes([
        { id: "%1", name: "server", status: "running", task: { id: "task-new", status: "running" } },
    ]);
    harness.inspectByPane.set("%1", {
        id: "%1",
        lines: ["replacement"],
        name: "server",
        status: "running",
        taskId: "task-new",
        taskStatus: "running",
    });
    await session.refresh();

    assert.equal(session.getSnapshot().active?.attached, false);
    assert.equal(session.getSnapshot().active?.taskId, undefined);
    assert.equal(session.getSnapshot().active?.warning, undefined);
});
