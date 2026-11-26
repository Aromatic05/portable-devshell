import assert from "node:assert/strict";
import { createElement } from "react";
import { PassThrough } from "node:stream";
import type { WriteStream } from "node:tty";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { TuiTerminalBuffer } from "../../src/terminal/emulation/Buffer.ts";
import { TuiSharedTerminalList } from "../../src/terminal/SharedList.ts";
import { TuiComponentSharedTerminals } from "../../src/terminal/SharedView.tsx";
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
