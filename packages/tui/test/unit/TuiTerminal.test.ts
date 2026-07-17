import assert from "node:assert/strict";
import test from "node:test";

import {
    pageFromShortcut,
    selectSidebarModel,
    TuiAppStore,
    TuiTerminalBuffer,
    TuiTerminalSession,
    type TuiTerminalPty,
    type TuiTerminalPtyFactory
} from "../../dist/testing.js";

function lineText(line: { segments: Array<{ text: string }> }): string {
    return line.segments.map((segment) => segment.text).join("");
}

test("terminal is an additional ninth page without changing existing shortcuts", () => {
    assert.equal(pageFromShortcut(1), "instances");
    assert.equal(pageFromShortcut(8), "help");
    assert.equal(pageFromShortcut(9), "terminal");

    const pages = selectSidebarModel(new TuiAppStore().getState()).pages;
    assert.equal(pages.at(-1)?.id, "terminal");
    assert.equal(pages.at(-1)?.label, "terminal");
});

test("headless terminal buffer applies cursor movement and SGR colors", async () => {
    const terminal = new TuiTerminalBuffer({ columns: 10, rows: 3 });

    await terminal.write("plain\r\n\u001B[31mred\u001B[0m");
    const snapshot = terminal.getSnapshot();

    assert.equal(lineText(snapshot.lines[0]!), "plain     ");
    assert.equal(lineText(snapshot.lines[1]!).slice(0, 3), "red");
    assert.equal(snapshot.lines[1]?.segments.some((segment) => segment.color === "#cd0000"), true);
    assert.deepEqual(snapshot.cursor, { x: 3, y: 1 });

    terminal.dispose();
});

test("terminal session connects PTY output, input, resize, and disposal", async () => {
    let dataListener: ((data: string) => void) | undefined;
    let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const writes: string[] = [];
    const resizes: Array<[number, number]> = [];
    let killed = false;
    const pty: TuiTerminalPty = {
        kill: () => {
            killed = true;
        },
        onData: (listener) => {
            dataListener = listener;
            return { dispose: () => undefined };
        },
        onExit: (listener) => {
            exitListener = listener;
            return { dispose: () => undefined };
        },
        resize: (columns, rows) => {
            resizes.push([columns, rows]);
        },
        write: (data) => {
            writes.push(data);
        }
    };
    const spawns: Array<{ args: string[]; columns: number; command: string; rows: number }> = [];
    const ptyFactory: TuiTerminalPtyFactory = (command, args, options) => {
        spawns.push({ args: [...args], columns: options.columns, command, rows: options.rows });
        return pty;
    };
    const session = new TuiTerminalSession({ ptyFactory });

    await session.start({
        columns: 12,
        command: { args: ["-l"], command: "/bin/sh" },
        instance: "alpha",
        rows: 4
    });
    dataListener?.("hello");
    await waitUntil(() => lineText(session.getSnapshot().lines[0]!).startsWith("hello"));

    assert.deepEqual(spawns, [{ args: ["-l"], columns: 12, command: "/bin/sh", rows: 4 }]);
    assert.equal(session.getSnapshot().status, "running");
    assert.equal(lineText(session.getSnapshot().lines[0]!).startsWith("hello"), true);

    session.writeInput("pwd\r");
    session.resize(20, 6);
    assert.deepEqual(writes, ["pwd\r"]);
    assert.deepEqual(resizes, [[20, 6]]);

    dataListener?.("\r\nfinal");
    exitListener?.({ exitCode: 0 });
    await waitUntil(() => session.getSnapshot().status === "exited");
    assert.equal(session.getSnapshot().status, "exited");
    assert.equal(
        session.getSnapshot().lines.some((line) => lineText(line).includes("final")),
        true
    );
    session.dispose();
    assert.equal(killed, true);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.fail("Condition was not met before timeout.");
}
