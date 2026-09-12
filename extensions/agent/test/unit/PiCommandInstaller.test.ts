import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@portable-devshell/extension";

import { ensureBundledPiCommand } from "../../src/builtin/pi/PiCommandInstaller.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

async function harness(t: test.TestContext) {
    const root = await createTestTempDirectory("agent-pi-command");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const codeDirectory = join(root, "code");
    const binDirectory = join(root, "bin");
    const launcher = join(codeDirectory, "dist", "builtin", "pi", "PiLauncher.js");
    await mkdir(join(codeDirectory, "dist", "builtin", "pi"), { recursive: true });
    await writeFile(launcher, "export async function launchInstalledPi() {}\n", "utf8");
    const context = {
        capabilities: {},
        generation: "test-generation",
        id: "agent",
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        paths: {
            codeDirectory,
            dataDirectory: join(root, "data"),
            runtimeDirectory: join(root, "runtime"),
            stateDirectory: join(root, "state")
        },
        register() {},
        version: "0.1.0"
    } as ExtensionContext;
    return { binDirectory, context, launcher, root };
}

test("Agent bundled Pi publishes its own Unix pi command", async (t) => {
    const h = await harness(t);
    const result = await ensureBundledPiCommand(h.context, {
        environment: { PORTABLE_DEVSHELL_BIN_DIR: h.binDirectory },
        homeDirectory: h.root,
        platform: "linux"
    });

    assert.equal(result.installed, true);
    assert.equal(result.command, join(h.binDirectory, "pi"));
    const source = await readFile(result.command, "utf8");
    assert.match(source, /portable-devshell-agent:pi-launcher-v1/u);
    assert.match(source, /PiLauncher\.js/u);
    assert.equal((await lstat(result.command)).mode & 0o111, 0o111);
});

test("Agent bundled Pi migrates the legacy core-owned pi launcher", async (t) => {
    const h = await harness(t);
    await mkdir(h.binDirectory, { recursive: true });
    const legacy = join(h.root, "portable-devshell", "current", "portable-devshell-pi-launcher.mjs");
    await mkdir(join(h.root, "portable-devshell", "current"), { recursive: true });
    await writeFile(legacy, "// legacy\n", "utf8");
    await symlink(legacy, join(h.binDirectory, "pi"));

    const result = await ensureBundledPiCommand(h.context, {
        environment: { PORTABLE_DEVSHELL_BIN_DIR: h.binDirectory },
        homeDirectory: h.root,
        platform: "linux"
    });

    assert.equal(result.installed, true);
    assert.equal((await lstat(result.command)).isSymbolicLink(), false);
    assert.match(await readFile(result.command, "utf8"), /portable-devshell-agent:pi-launcher-v1/u);
});

test("Agent bundled Pi never replaces a foreign pi command", async (t) => {
    const h = await harness(t);
    await mkdir(h.binDirectory, { recursive: true });
    const command = join(h.binDirectory, "pi");
    await writeFile(command, "#!/bin/sh\necho foreign-pi\n", { mode: 0o755 });

    const result = await ensureBundledPiCommand(h.context, {
        environment: { PORTABLE_DEVSHELL_BIN_DIR: h.binDirectory },
        homeDirectory: h.root,
        platform: "linux"
    });

    assert.deepEqual(result, { command, installed: false, reason: "collision" });
    assert.equal(await readFile(command, "utf8"), "#!/bin/sh\necho foreign-pi\n");
});
