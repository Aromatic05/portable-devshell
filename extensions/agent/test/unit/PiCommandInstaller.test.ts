import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
    lstat,
    mkdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ExtensionContext } from "@portable-devshell/extension";

import { ensurePiCommand } from "../../src/builtin/pi/PiCommandInstaller.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const runFile = promisify(execFile);

async function harness(t: test.TestContext, label = "current") {
    const root = await createTestTempDirectory("agent-pi-command");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const codeDirectory = join(root, "code");
    const binDirectory = join(root, "bin");
    const launcher = join(
        codeDirectory,
        "dist",
        "builtin",
        "pi",
        "PiLauncher.js",
    );
    await mkdir(join(codeDirectory, "dist", "builtin", "pi"), {
        recursive: true,
    });
    await writeLauncher(launcher, label);
    const context = {
        capabilities: {},
        generation: "test-generation",
        id: "agent",
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        paths: {
            codeDirectory,
            dataDirectory: join(root, "data"),
            runtimeDirectory: join(root, "runtime"),
            stateDirectory: join(root, "state"),
        },
        register() {},
        version: "0.1.0",
    } as ExtensionContext;
    return { binDirectory, context, root };
}

test("Agent Pi Provider publishes its own Unix pi command", async (t) => {
    const h = await harness(t);
    const result = await withRestrictiveUmask(
        async () =>
            await ensurePiCommand(h.context, {
                environment: { PORTABLE_DEVSHELL_BIN_DIR: h.binDirectory },
                homeDirectory: h.root,
                platform: "linux",
            }),
    );

    assert.equal(result.installed, true);
    assert.equal(result.command, join(h.binDirectory, "pi"));
    assert.equal((await runFile(result.command)).stdout, "current\n");
    if (process.platform !== "win32") {
        assert.equal((await lstat(result.command)).mode & 0o111, 0o111);
    }
});

async function withRestrictiveUmask<T>(
    operation: () => Promise<T>,
): Promise<T> {
    if (process.platform === "win32") return await operation();
    const previous = process.umask(0o077);
    try {
        return await operation();
    } finally {
        process.umask(previous);
    }
}

test("Agent Pi Provider migrates the legacy core-owned pi launcher", async (t) => {
    const h = await harness(t);
    await mkdir(h.binDirectory, { recursive: true });
    const legacy = join(
        h.root,
        "portable-devshell",
        "current",
        "portable-devshell-pi-launcher.mjs",
    );
    await mkdir(join(h.root, "portable-devshell", "current"), {
        recursive: true,
    });
    await writeFile(legacy, "// legacy\n", "utf8");
    await symlink(legacy, join(h.binDirectory, "pi"));

    const result = await ensurePiCommand(h.context, {
        environment: { PORTABLE_DEVSHELL_BIN_DIR: h.binDirectory },
        homeDirectory: h.root,
        platform: "linux",
    });

    assert.equal(result.installed, true);
    assert.equal((await lstat(result.command)).isSymbolicLink(), false);
    assert.equal((await runFile(result.command)).stdout, "current\n");
});

test("Agent Pi command follows the current Extension generation", async (t) => {
    const h = await harness(t, "generation-a");
    const options = {
        environment: { PORTABLE_DEVSHELL_BIN_DIR: h.binDirectory },
        homeDirectory: h.root,
        platform: "linux" as const,
    };
    const first = await ensurePiCommand(h.context, options);
    assert.equal((await runFile(first.command)).stdout, "generation-a\n");

    const nextCodeDirectory = join(h.root, "code-next");
    const nextLauncher = join(
        nextCodeDirectory,
        "dist",
        "builtin",
        "pi",
        "PiLauncher.js",
    );
    await mkdir(join(nextCodeDirectory, "dist", "builtin", "pi"), {
        recursive: true,
    });
    await writeLauncher(nextLauncher, "generation-b");
    const nextContext = {
        ...h.context,
        generation: "test-generation-next",
        paths: { ...h.context.paths, codeDirectory: nextCodeDirectory },
    } satisfies ExtensionContext;

    const second = await ensurePiCommand(nextContext, options);
    assert.equal(second.command, first.command);
    assert.equal((await runFile(second.command)).stdout, "generation-b\n");
});

test("Agent Pi Provider never replaces a foreign pi command", async (t) => {
    const h = await harness(t);
    await mkdir(h.binDirectory, { recursive: true });
    const command = join(h.binDirectory, "pi");
    await writeFile(command, "#!/bin/sh\necho foreign-pi\n", { mode: 0o755 });

    const result = await ensurePiCommand(h.context, {
        environment: { PORTABLE_DEVSHELL_BIN_DIR: h.binDirectory },
        homeDirectory: h.root,
        platform: "linux",
    });

    assert.deepEqual(result, {
        command,
        installed: false,
        reason: "collision",
    });
    assert.equal((await runFile(command)).stdout, "foreign-pi\n");
});

async function writeLauncher(path: string, label: string): Promise<void> {
    await writeFile(
        path,
        `export async function launchInstalledPi() { process.stdout.write(${JSON.stringify(label + "\n")}); }\n`,
        "utf8",
    );
}
