import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodePtyTerminalBackend } from "../../src/control/terminal/NodePtyTerminalBackend.ts";

const unixOnly = process.platform === "win32" ? { skip: "stty acceptance requires a Unix PTY" } : {};

test("real PTY carries shell input/output and applies resize", unixOnly, async (t) => {
    const backend = new NodePtyTerminalBackend({
        resolve: (input) => ({
            args: [],
            cwd: input.cwd,
            env: process.env,
            executable: "/bin/sh",
        }),
    });
    const processHandle = await backend.open({
        cols: 80,
        cwd: process.cwd(),
        rows: 24,
    });
    t.after(() => processHandle.kill());

    let output = "";
    const changed: Array<() => void> = [];
    processHandle.onData((chunk) => {
        output += chunk;
        for (const listener of changed.splice(0)) listener();
    });

    processHandle.write("printf 'pty-ready\\n'\r");
    await waitFor(() => output.includes("pty-ready"), changed);

    output = "";
    processHandle.write("stty size\r");
    await waitFor(() => /24\s+80/u.test(output), changed);

    output = "";
    processHandle.resize(100, 40);
    processHandle.write("stty size\r");
    await waitFor(() => /40\s+100/u.test(output), changed);

    assert.match(output, /40\s+100/u);
});

test(
    "real zsh PTY accepts the first command in an empty HOME without opening the new-user wizard",
    process.platform === "win32" || spawnSync("zsh", ["--version"]).status !== 0
        ? { skip: "zsh is unavailable" }
        : {},
    async (t) => {
        const home = await mkdtemp(join(tmpdir(), "pds-zsh-home-"));
        t.after(async () => await rm(home, { force: true, recursive: true }));
        const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home };
        delete environment.ZDOTDIR;
        const backend = new NodePtyTerminalBackend({
            resolve: () => ({
                args: ["-l"],
                cwd: home,
                env: environment,
                executable: "zsh",
            }),
        });
        const processHandle = await backend.open({ cols: 80, rows: 24 });
        t.after(() => processHandle.kill());
        let output = "";
        const changed: Array<() => void> = [];
        processHandle.onData((chunk) => {
            output += chunk;
            for (const listener of changed.splice(0)) listener();
        });

        processHandle.write("printf '%s%s\\n' 'first-' 'command-ready'\r");
        await waitFor(() => output.includes("first-command-ready"), changed);
        assert.doesNotMatch(output, /zsh-newuser-install|command not found: rintf/u);
    },
);

async function waitFor(predicate: () => boolean, changed: Array<() => void>): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for PTY output.");
        }
        await Promise.race([
            new Promise<void>((resolve) => changed.push(resolve)),
            new Promise<void>((resolve) => setTimeout(resolve, 25)),
        ]);
    }
}
