import assert from "node:assert/strict";
import { createElement } from "react";
import { PassThrough } from "node:stream";
import type { WriteStream } from "node:tty";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { TuiTerminalBuffer } from "../../src/terminal/emulation/Buffer.ts";
import { TuiTerminalController } from "../../src/terminal/Controller.ts";
import { TuiTerminalSession } from "../../src/terminal/emulation/Session.ts";
import { projectTuiTerminalInputFrame } from "../../src/terminal/Input.js";
import { TuiSharedTerminalList } from "../../src/terminal/SharedList.ts";
import { TuiComponentSharedTerminals } from "../../src/terminal/SharedView.tsx";
import { TuiAppStore } from "../../src/state/store/App.js";
import type { TuiDomainSession } from "../../src/app/control/Client.js";
import type { TerminalSessionDescriptor } from "@portable-devshell/shared";

function terminal(id: string, instance: string): TerminalSessionDescriptor {
    return {
        terminalId: id,
        instance,
        generation: 1,
        version: 1,
        state: "running",
        cols: 80,
        rows: 24,
        latestSeq: 0,
        createdAt: "2026-01-01T00:00:00Z",
    };
}

test("shared terminal selection attaches the exact discovered process and returns to the list", async () => {
    const list = new TuiSharedTerminalList(async () => [
        terminal("first", "alpha"),
        terminal("second", "alpha"),
    ]);
    await list.bind("alpha");
    list.move(1);
    assert.equal(list.enter()?.terminalId, "second");
    list.leave();
    assert.equal(list.getSnapshot().active, undefined);
    assert.equal(list.getSnapshot().selectedIndex, 1);
    list.dispose();
});

test("changing the instance ignores the previous instance's delayed terminal listing", async () => {
    let resolve!: (value: TerminalSessionDescriptor[]) => void;
    const list = new TuiSharedTerminalList(async (instance) =>
        instance === "alpha"
            ? await new Promise<TerminalSessionDescriptor[]>((done) => {
                  resolve = done;
              })
            : [terminal("beta", "beta")],
    );
    const first = list.bind("alpha");
    await list.bind("beta");
    resolve([terminal("alpha", "alpha")]);
    await first;
    assert.equal(list.getSnapshot().sessions[0]?.terminalId, "beta");
    list.dispose();
});

test("shared terminal list supports observe/control modes, creating persistent sessions, and closing selected sessions", async () => {
    const sessions: TerminalSessionDescriptor[] = [
        {
            ...terminal("first", "alpha"),
            name: "build-shell",
            persistent: true,
        },
    ];
    const killed: string[] = [];
    const openedInputs: unknown[] = [];
    const list = new TuiSharedTerminalList({
        list: async () => [...sessions],
        open: async (instance, input) => {
            openedInputs.push(input);
            const created: TerminalSessionDescriptor = {
                ...terminal("created", instance),
                cols: input.cols,
                persistent: input.persistent,
                rows: input.rows,
            };
            sessions.push(created);
            return created;
        },
        kill: async (_instance, identity) => {
            killed.push(identity.terminalId);
            const index = sessions.findIndex(
                (item) => item.terminalId === identity.terminalId,
            );
            const [removed] = sessions.splice(index, 1);
            return { ...removed!, state: "killed" };
        },
    });
    await list.bind("alpha");
    assert.equal(list.enter("observe")?.terminalId, "first");
    assert.equal(list.getSnapshot().mode, "observe");
    list.setMode("control");
    assert.equal(list.getSnapshot().mode, "control");
    list.leave();

    const created = await list.create(120, 36);
    assert.equal(created?.terminalId, "created");
    assert.equal(list.getSnapshot().mode, "control");
    assert.deepEqual(openedInputs, [{ cols: 120, persistent: true, rows: 36 }]);
    list.leave();

    assert.equal(await list.closeSelected(), true);
    assert.deepEqual(killed, ["created"]);
    assert.equal(list.getSnapshot().sessions.length, 1);
    list.dispose();
});

test("closeSelected refreshes and retries once on stale version conflict", async () => {
    const sessions: TerminalSessionDescriptor[] = [
        { ...terminal("target", "alpha"), version: 1 },
    ];
    const killVersions: number[] = [];
    const list = new TuiSharedTerminalList({
        list: async () => sessions.map((session) => ({ ...session })),
        kill: async (_instance, identity) => {
            killVersions.push(identity.version);
            if (identity.version === 1) {
                sessions[0] = { ...sessions[0]!, version: 2 };
                const error = new Error("stale version mismatch");
                (error as { code?: string }).code = "instance.conflict";
                throw error;
            }
            const [removed] = sessions.splice(0, 1);
            return { ...removed!, state: "killed", version: 3 };
        },
    });
    await list.bind("alpha");
    assert.equal(await list.closeSelected(), true);
    assert.deepEqual(killVersions, [1, 2]);
    assert.equal(list.getSnapshot().sessions.length, 0);
    assert.equal(list.getSnapshot().error, undefined);
    list.dispose();
});

test("SharedView renders state.error in header while state.active is set", async () => {
    const list = new TuiSharedTerminalList(async () => [
        { ...terminal("sess-1", "alpha"), name: "dev" },
    ]);
    await list.bind("alpha");
    list.enter("observe");
    list.setError("takeover busy");

    const buffer = new TuiTerminalBuffer({ columns: 80, rows: 10 });
    const snapshot = { ...buffer.getSnapshot(), status: "running" as const };
    const output = new PassThrough();
    Object.assign(output, { columns: 120 });
    let text = "";
    output.on("data", (chunk) => {
        text += chunk.toString();
    });
    const view = render(
        createElement(TuiComponentSharedTerminals, {
            columns: 120,
            rows: 10,
            focused: true,
            instance: "alpha",
            source: list,
            terminal: {
                getSnapshot: () => snapshot,
                subscribe: () => () => undefined,
            },
            onGraphicsVisibility() {},
        }),
        {
            stdout: output as unknown as WriteStream,
            debug: true,
            patchConsole: false,
            exitOnCtrlC: false,
        },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    view.cleanup();
    output.destroy();
    buffer.dispose();
    list.dispose();

    const plain = stripVTControlCharacters(text);
    assert.match(plain, /error: takeover busy/u);
    assert.match(plain, /\[OBSERVE\]/u);
});

test("SharedView renders workspace alongside command or when command/cwd are absent", async () => {
    const list = new TuiSharedTerminalList(async () => [
        {
            ...terminal("sess-cmd", "alpha"),
            command: "/bin/bash",
            workspace: "/repo/a",
        },
        {
            ...terminal("sess-ws", "alpha"),
            workspace: "/repo/b",
        },
    ]);
    await list.bind("alpha");

    const output = new PassThrough();
    Object.assign(output, { columns: 120 });
    let text = "";
    output.on("data", (chunk) => {
        text += chunk.toString();
    });
    const view = render(
        createElement(TuiComponentSharedTerminals, {
            columns: 120,
            rows: 10,
            focused: true,
            instance: "alpha",
            source: list,
            terminal: {
                getSnapshot: () => ({
                    ...new TuiTerminalBuffer({ columns: 80, rows: 10 }).getSnapshot(),
                    status: "running" as const,
                }),
                subscribe: () => () => undefined,
            },
            onGraphicsVisibility() {},
        }),
        {
            stdout: output as unknown as WriteStream,
            debug: true,
            patchConsole: false,
            exitOnCtrlC: false,
        },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    view.cleanup();
    output.destroy();
    list.dispose();

    const plain = stripVTControlCharacters(text);
    assert.match(plain, /\/bin\/bash · \/repo\/a/u);
    assert.match(plain, /80x24 · \/repo\/b/u);
});

test("SharedList supports inline naming lifecycle, validates names, and clamps pipe tasks to observe", async () => {
    const openedInputs: unknown[] = [];
    const sessions: TerminalSessionDescriptor[] = [
        {
            ...terminal("pipe-1", "alpha"),
            cols: 0,
            command: "npm test",
            name: "test-job",
            pty: false,
            rows: 0,
        },
    ];
    const list = new TuiSharedTerminalList({
        list: async () => [...sessions],
        open: async (instance, input) => {
            openedInputs.push(input);
            const created: TerminalSessionDescriptor = {
                ...terminal("created-named", instance),
                cols: input.cols,
                name: input.name,
                persistent: input.persistent,
                rows: input.rows,
            };
            sessions.push(created);
            return created;
        },
    });
    await list.bind("alpha");

    assert.equal(list.enter("control")?.terminalId, "pipe-1");
    assert.equal(list.getSnapshot().mode, "observe");
    list.leave();

    list.beginCreate();
    assert.deepEqual(list.getSnapshot().creating, { name: "" });
    list.updateCreateName("bad name!");
    assert.equal(await list.create(100, 30, "bad name!"), undefined);
    assert.match(list.getSnapshot().error ?? "", /Session name must/u);
    assert.deepEqual(openedInputs, []);

    list.cancelCreate();
    assert.equal(list.getSnapshot().creating, undefined);
    assert.equal(list.getSnapshot().error, undefined);

    list.beginCreate();
    list.updateCreateName("ops-shell");
    const created = await list.create(100, 30, " ops-shell ");
    assert.equal(created?.name, "ops-shell");
    assert.equal(list.getSnapshot().creating, undefined);
    assert.deepEqual(openedInputs, [
        { cols: 100, name: "ops-shell", persistent: true, rows: 30 },
    ]);
    list.dispose();
});

async function renderSharedView(
    list: TuiSharedTerminalList,
): Promise<string> {
    const output = new PassThrough();
    Object.assign(output, { columns: 120 });
    let text = "";
    output.on("data", (chunk) => {
        text += chunk.toString();
    });
    const buffer = new TuiTerminalBuffer({ columns: 80, rows: 10 });
    const snapshot = { ...buffer.getSnapshot(), status: "running" as const };
    const view = render(
        createElement(TuiComponentSharedTerminals, {
            columns: 120,
            rows: 10,
            focused: true,
            instance: "alpha",
            source: list,
            terminal: {
                getSnapshot: () => snapshot,
                subscribe: () => () => undefined,
            },
            onGraphicsVisibility() {},
        }),
        {
            stdout: output as unknown as WriteStream,
            debug: true,
            patchConsole: false,
            exitOnCtrlC: false,
        },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    view.cleanup();
    output.destroy();
    buffer.dispose();
    return stripVTControlCharacters(text);
}

test("SharedView renders pipe row/header, Alt+o control hint, and inline create prompt with error", async () => {
    const list = new TuiSharedTerminalList(async () => [
        {
            ...terminal("pipe-1", "alpha"),
            cols: 0,
            command: "tail -f app.log",
            name: "logs",
            pty: false,
            rows: 0,
        },
        {
            ...terminal("pty-1", "alpha"),
            name: "shell",
            persistent: true,
        },
    ]);
    await list.bind("alpha");

    const listScreen = await renderSharedView(list);
    assert.match(listScreen, /logs \(pipe-1\) · \[pipe\] · tail -f app\.log/u);
    assert.doesNotMatch(listScreen, /0x0/u);

    list.beginCreate();
    list.updateCreateName("my-shell");
    list.setError("invalid name");
    const promptScreen = await renderSharedView(list);
    assert.match(
        promptScreen,
        /New persistent shell name \(optional, Enter create, Esc cancel\): my-shell█/u,
    );
    assert.match(promptScreen, /invalid name/u);
    list.cancelCreate();

    list.enter("control");
    const pipeActiveScreen = await renderSharedView(list);
    assert.match(pipeActiveScreen, /\[PIPE\]/u);
    assert.match(pipeActiveScreen, /read-only log · q\/Esc back · Ctrl\+\] sidebar/u);
    list.leave();

    list.move(1);
    list.enter("control");
    const ptyControlScreen = await renderSharedView(list);
    assert.match(ptyControlScreen, /\[CONTROL\]/u);
    assert.match(ptyControlScreen, /Alt\+o release to observe · Ctrl\+\] sidebar/u);
    list.dispose();
});

test("TuiTerminalController handles Alt+o release to observe, inline naming via n, and pipe t error", async () => {
    assert.deepEqual(
        projectTuiTerminalInputFrame({ data: "\u001Bo", type: "data" }),
        { type: "control.release" },
    );
    assert.deepEqual(
        projectTuiTerminalInputFrame({ data: "\u001BO", type: "data" }),
        { type: "control.release" },
    );

    const store = new TuiAppStore();
    store.setSelectedInstance("alpha");
    store.setSelectedPage("terminal");
    store.replaceRoute({ page: "terminal", tab: "sessions", view: "session" });
    store.setFocusScope("terminal");

    const openedInputs: unknown[] = [];
    const controlCalls: Array<{
        instance: string;
        takeover: boolean;
        terminalId: string;
    }> = [];
    const ptyWrites: string[] = [];
    const sessions: TerminalSessionDescriptor[] = [
        {
            ...terminal("pty-1", "alpha"),
            humanControl: true,
            name: "shell",
            persistent: true,
        },
        {
            ...terminal("pipe-1", "alpha"),
            cols: 0,
            name: "job",
            pty: false,
            rows: 0,
        },
    ];
    const sharedTerminals = new TuiSharedTerminalList({
        list: async () => [...sessions],
        open: async (instance, input) => {
            openedInputs.push(input);
            const created: TerminalSessionDescriptor = {
                ...terminal("pty-new", instance),
                cols: input.cols,
                humanControl: true,
                name: input.name,
                persistent: input.persistent,
                rows: input.rows,
            };
            sessions.push(created);
            return created;
        },
    });
    await sharedTerminals.bind("alpha");

    const ptySession = new TuiTerminalSession({
        ptyFactory: () => ({
            kill() {},
            onData() {
                return { dispose() {} };
            },
            onExit() {
                return { dispose() {} };
            },
            resize() {},
            write(data: string) {
                ptyWrites.push(data);
            },
        }),
    });

    const pendingOps: Promise<void>[] = [];
    const controller = new TuiTerminalController({
        columns: () => 80,
        copyText() {},
        domains: {
            instances: { state: { instances: [{ name: "alpha" }] } },
        } as unknown as TuiDomainSession,
        enqueueInput: (operation) => {
            pendingOps.push(Promise.resolve(operation()));
        },
        graphicsSupport: { kitty: false, sixel: false },
        handleAppMouse: async () => {},
        rows: () => 24,
        setSharedControl: async (instance, terminalId, takeover) => {
            controlCalls.push({ instance, takeover, terminalId });
        },
        sharedTerminals,
        stdout: { write() {} } as unknown as WriteStream,
        store,
        terminal: ptySession,
        writeAppInput() {},
    });

    // Enter PTY session in control mode and release with Alt+o
    controller.dispatchInputActions([{ data: "\r", type: "data" }]);
    await Promise.all(pendingOps.splice(0));
    assert.equal(sharedTerminals.getSnapshot().mode, "control");

    controller.dispatchInputActions([{ type: "control.release" }]);
    await Promise.all(pendingOps.splice(0));
    assert.deepEqual(controlCalls, [
        { instance: "alpha", takeover: false, terminalId: "pty-1" },
    ]);
    assert.equal(sharedTerminals.getSnapshot().active?.terminalId, "pty-1");
    assert.equal(sharedTerminals.getSnapshot().mode, "observe");

    // Leave back to list via q
    controller.dispatchInputActions([{ data: "q", type: "data" }]);
    assert.equal(sharedTerminals.getSnapshot().active, undefined);

    // Press n, type name (including ignored shortcut letters like 'r'/'j'), then Enter
    controller.dispatchInputActions([{ data: "n", type: "data" }]);
    assert.deepEqual(sharedTerminals.getSnapshot().creating, { name: "" });
    controller.dispatchInputActions([
        { data: "r", type: "data" },
        { data: "j", type: "data" },
        { data: "\r", type: "data" },
    ]);
    await Promise.all(pendingOps.splice(0));
    assert.deepEqual(openedInputs, [
        { cols: 1, name: "rj", persistent: true, rows: 1 },
    ]);
    assert.equal(sharedTerminals.getSnapshot().active?.name, "rj");

    // Release from control to observe, leave back to list, select pipe-1, Enter clamps to observe, pressing t sets error
    controller.dispatchInputActions([{ type: "control.release" }]);
    await Promise.all(pendingOps.splice(0));
    controller.dispatchInputActions([{ data: "q", type: "data" }]);
    await sharedTerminals.refresh();
    sharedTerminals.move(-1);
    controller.dispatchInputActions([{ data: "\r", type: "data" }]);
    await Promise.all(pendingOps.splice(0));
    assert.equal(sharedTerminals.getSnapshot().mode, "observe");
    controller.dispatchInputActions([{ data: "t", type: "data" }]);
    assert.equal(sharedTerminals.getSnapshot().error, "Pipe tasks are read-only");
    assert.equal(controlCalls.length, 2);

    // On instances tab, Alt+o forwards "\u001Bo" to PTY
    controller.selectTab("instances");
    await controller.open("alpha", 80, 24);
    controller.dispatchInputActions([{ type: "control.release" }]);
    assert.deepEqual(ptyWrites, ["\u001Bo"]);

    ptySession.dispose();
    sharedTerminals.dispose();
});
