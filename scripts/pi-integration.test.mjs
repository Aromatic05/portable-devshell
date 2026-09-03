import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
    activatePiIntegration,
    capturePiIntegration,
    resolvePiDeploymentTargets,
    restorePiIntegration
} from "./pi-integration.mjs";

test("Pi integration installs a devshell-only launcher and default extension loader", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-pi-integration-"));
    const home = resolve(root, "home");
    const binDirectory = resolve(home, ".local", "bin");
    const currentLink = resolve(root, "current");
    try {
        const controlTarget = resolve(currentLink, "node_modules", "@portable-devshell", "control", "dist", "index.js");
        const agentdTarget = resolve(currentLink, "node_modules", "@portable-devshell", "agentd", "dist", "index.js");
        const piRoot = resolve(currentLink, "node_modules", "@earendil-works", "pi-coding-agent");
        const piTarget = resolve(piRoot, "dist", "bundle", "cli.js");
        const extensionRoot = resolve(currentLink, "node_modules", "@portable-devshell", "pi-extension");
        const extensionTarget = resolve(extensionRoot, "dist", "index.js");
        await mkdir(resolve(controlTarget, ".."), { recursive: true });
        await mkdir(resolve(agentdTarget, ".."), { recursive: true });
        await mkdir(resolve(piTarget, ".."), { recursive: true });
        await mkdir(resolve(extensionTarget, ".."), { recursive: true });
        await writeFile(controlTarget, "export {};\n", "utf8");
        await writeFile(agentdTarget, "export {};\n", "utf8");
        await writeFile(
            resolve(currentLink, "node_modules", "@portable-devshell", "agentd", "package.json"),
            JSON.stringify({ main: "dist/index.js" }),
            "utf8"
        );
        await writeFile(resolve(piRoot, "package.json"), JSON.stringify({ bin: { pi: "dist/bundle/cli.js" } }), "utf8");
        await writeFile(resolve(extensionRoot, "package.json"), JSON.stringify({ main: "dist/index.js" }), "utf8");
        await writeFile(piTarget, "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
        await writeFile(extensionTarget, "export default () => {}; export const marker = 'devshell';\n", "utf8");

        assert.deepEqual(await resolvePiDeploymentTargets(currentLink), { extensionTarget, piTarget });
        const before = await capturePiIntegration({ binDirectory, currentLink, home, platform: "linux" });
        const paths = await activatePiIntegration({ binDirectory, currentLink, home, platform: "linux" });
        const launched = spawnSync(paths.command, ["hello"], { encoding: "utf8" });
        assert.equal(launched.status, 0, launched.stderr);
        assert.deepEqual(JSON.parse(launched.stdout.trim()), ["--no-builtin-tools", "hello"]);
        const withBuiltins = spawnSync(paths.command, ["hello"], {
            encoding: "utf8",
            env: { ...process.env, DEVSHELL_PI_BUILTIN_TOOLS: "1" }
        });
        assert.deepEqual(JSON.parse(withBuiltins.stdout.trim()), ["hello"]);
        assert.match(await readFile(paths.extension, "utf8"), /pi-extension\/dist\/index\.js/u);

        await restorePiIntegration(before);
        await assert.rejects(() => readFile(paths.command), /ENOENT/u);
        await assert.rejects(() => readFile(paths.extension), /ENOENT/u);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
