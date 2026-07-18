import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { resolvePnpmCommand } from "./PnpmCommand.mjs";

test("Unix invokes pnpm directly", () => {
    assert.deepEqual(resolvePnpmCommand({ platform: "linux" }), {
        args: [],
        command: "pnpm"
    });
});

test("Windows invokes the PNPM_HOME JavaScript entry through Node", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-pnpm-command-"));
    try {
        const pnpmHome = resolve(root, "node_modules", ".bin");
        const cli = resolve(root, "node_modules", "pnpm", "bin", "pnpm.cjs");
        await mkdir(resolve(cli, ".."), { recursive: true });
        await writeFile(cli, "", "utf8");

        assert.deepEqual(
            resolvePnpmCommand({
                environment: { PNPM_HOME: pnpmHome },
                nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
                platform: "win32"
            }),
            {
                args: [cli],
                command: "C:\\Program Files\\nodejs\\node.exe"
            }
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Windows rejects packaging without a resolvable pnpm JavaScript entry", () => {
    assert.throws(
        () => resolvePnpmCommand({ environment: {}, platform: "win32" }),
        /Cannot locate pnpm\.cjs/u
    );
});
