import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    activatePiIntegration,
    capturePiIntegration,
    deactivatePiIntegration,
    persistOriginalPiIntegrationSnapshot,
    resolvePiDeploymentTargets,
    restorePiIntegration
} from "./pi-integration.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("bundled Pi keeps launch cwd while ignoring project-local resources", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-pi-compatibility-"));
    const agentDir = resolve(root, "agent");
    const project = resolve(root, "project");
    const sessionFile = resolve(root, "session", "probe.jsonl");
    const piTarget = resolve(
        repoRoot,
        "packages",
        "pi-extension",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "bundle",
        "cli.js"
    );
    try {
        await mkdir(resolve(agentDir, "prompts"), { recursive: true });
        await mkdir(resolve(project, ".pi", "prompts"), { recursive: true });
        await mkdir(resolve(sessionFile, ".."), { recursive: true });
        await writeFile(resolve(agentDir, "prompts", "global-only.md"), "global prompt\n", "utf8");
        await writeFile(resolve(project, ".pi", "prompts", "local-only.md"), "local prompt\n", "utf8");
        await writeFile(sessionFile, "", "utf8");

        const pi = spawnSync(process.execPath, [
            piTarget,
            "--offline",
            "--mode",
            "rpc",
            "--no-extensions",
            "--no-builtin-tools",
            "--no-approve",
            "--session",
            sessionFile
        ], {
            cwd: project,
            encoding: "utf8",
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: agentDir,
                PI_OFFLINE: "1"
            },
            input: '{"type":"get_commands","id":"commands-1"}\n'
        });
        assert.equal(pi.status, 0, pi.stderr);
        const response = JSON.parse(pi.stdout.trim());
        assert.equal(response.success, true);
        const commandNames = response.data.commands.map((command) => command.name);
        assert.equal(commandNames.includes("global-only"), true);
        assert.equal(commandNames.includes("local-only"), false);

        const header = JSON.parse((await readFile(sessionFile, "utf8")).split("\n")[0]);
        assert.equal(resolve(header.cwd), project);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

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
        await writeFile(piTarget, [
            "console.log(JSON.stringify({",
            "  args: process.argv.slice(2),",
            "  cwd: process.cwd(),",
            "  workspace: process.env.PORTABLE_DEVSHELL_PI_WORKSPACE",
            "}));",
            ""
        ].join("\n"), "utf8");
        await writeFile(extensionTarget, "export default () => {}; export const marker = 'devshell';\n", "utf8");

        assert.deepEqual(await resolvePiDeploymentTargets(currentLink), { extensionTarget, piTarget });
        const before = await capturePiIntegration({ binDirectory, currentLink, home, platform: "linux" });
        const paths = await activatePiIntegration({ binDirectory, currentLink, home, platform: "linux" });
        const launcherEnvironment = { ...process.env };
        const launched = spawnSync(paths.command, ["hello"], {
            cwd: root,
            encoding: "utf8",
            env: launcherEnvironment
        });
        assert.equal(launched.status, 0, launched.stderr);
        const launchedState = JSON.parse(launched.stdout.trim());
        assert.deepEqual(launchedState.args, ["--no-builtin-tools", "hello", "--no-approve"]);
        assert.equal(launchedState.workspace, root);
        assert.equal(launchedState.cwd, root);
        const withBuiltins = spawnSync(paths.command, ["hello"], {
            cwd: root,
            encoding: "utf8",
            env: { ...launcherEnvironment, DEVSHELL_PI_BUILTIN_TOOLS: "1" }
        });
        const withBuiltinsState = JSON.parse(withBuiltins.stdout.trim());
        assert.deepEqual(withBuiltinsState.args, ["hello", "--no-approve"]);
        assert.equal(withBuiltinsState.workspace, root);
        assert.equal(withBuiltinsState.cwd, root);

        const explicitApprove = spawnSync(paths.command, ["--approve", "hello"], {
            cwd: root,
            encoding: "utf8",
            env: launcherEnvironment
        });
        assert.equal(explicitApprove.status, 0, explicitApprove.stderr);
        assert.deepEqual(JSON.parse(explicitApprove.stdout.trim()).args, [
            "--no-builtin-tools",
            "--approve",
            "hello",
            "--no-approve"
        ]);

        const literalApprove = spawnSync(paths.command, ["--", "--approve"], {
            cwd: root,
            encoding: "utf8",
            env: launcherEnvironment
        });
        assert.equal(literalApprove.status, 0, literalApprove.stderr);
        assert.deepEqual(JSON.parse(literalApprove.stdout.trim()).args, [
            "--no-builtin-tools",
            "--no-approve",
            "--",
            "--approve"
        ]);

        for (const managementArgs of [
            ["install", "example-package"],
            ["remove", "example-package"],
            ["uninstall", "example-package"],
            ["update"],
            ["list"],
            ["config", "get", "theme"],
            ["auth", "status"]
        ]) {
            const management = spawnSync(paths.command, managementArgs, {
                cwd: root,
                encoding: "utf8",
                env: launcherEnvironment
            });
            assert.equal(management.status, 0, management.stderr);
            assert.deepEqual(JSON.parse(management.stdout.trim()).args, managementArgs);
        }
        for (const metadataArgs of [["--help"], ["--version"]]) {
            const metadata = spawnSync(paths.command, metadataArgs, {
                cwd: root,
                encoding: "utf8",
                env: launcherEnvironment
            });
            assert.equal(metadata.status, 0, metadata.stderr);
            assert.deepEqual(JSON.parse(metadata.stdout.trim()).args, metadataArgs);
        }
        assert.match(await readFile(paths.command, "utf8"), /portable-devshell managed Pi launcher/u);
        assert.match(await readFile(paths.extension, "utf8"), /portable-devshell managed Pi extension loader/u);
        assert.match(await readFile(paths.extension, "utf8"), /pi-extension\/dist\/index\.js/u);

        await restorePiIntegration(before);
        await assert.rejects(() => readFile(paths.command), /ENOENT/u);
        await assert.rejects(() => readFile(paths.extension), /ENOENT/u);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Pi integration persists the pre-install user state once and restores it on deactivate", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-pi-original-"));
    const home = resolve(root, "home");
    const binDirectory = resolve(root, "bin");
    const snapshotPath = resolve(root, "install", "pi-integration-original.json");
    const command = resolve(binDirectory, "pi");
    const extension = resolve(home, ".pi", "agent", "extensions", "devshell.js");
    try {
        await mkdir(binDirectory, { recursive: true });
        await mkdir(resolve(extension, ".."), { recursive: true });
        await writeFile(resolve(root, "user-pi"), "user pi\n", "utf8");
        await symlink(resolve(root, "user-pi"), command);
        await writeFile(extension, "export default function userExtension() {}\n", "utf8");

        const original = await capturePiIntegration({ binDirectory, home, platform: "linux" });
        assert.equal(await persistOriginalPiIntegrationSnapshot(snapshotPath, original, "linux"), true);
        assert.equal(await persistOriginalPiIntegrationSnapshot(snapshotPath, {
            ...original,
            extension: { content: Buffer.from("changed\n"), kind: "file", mode: 0o600 }
        }, "linux"), false);

        await rm(command, { force: true });
        await writeFile(command, "#!/usr/bin/env node\n// portable-devshell managed Pi launcher\n", { mode: 0o755 });
        await writeFile(extension, "// portable-devshell managed Pi extension loader\n", "utf8");
        assert.deepEqual(await deactivatePiIntegration(snapshotPath, { binDirectory, home, platform: "linux" }), {
            restoredOriginal: true
        });
        assert.equal(await readlink(command), resolve(root, "user-pi"));
        assert.equal(await readFile(extension, "utf8"), "export default function userExtension() {}\n");

        await rm(command, { force: true });
        await writeFile(command, "#!/bin/sh\necho replacement-pi\n", "utf8");
        await writeFile(extension, "// portable-devshell managed Pi extension loader\n", "utf8");
        await deactivatePiIntegration(snapshotPath, { binDirectory, home, platform: "linux" });
        assert.equal(await readFile(command, "utf8"), "#!/bin/sh\necho replacement-pi\n");
        assert.equal(await readFile(extension, "utf8"), "export default function userExtension() {}\n");

        await rm(command, { force: true });
        await writeFile(command, "#!/usr/bin/env node\n// portable-devshell managed Pi launcher\n", "utf8");
        await writeFile(extension, "export default function replacementExtension() {}\n", "utf8");
        await deactivatePiIntegration(snapshotPath, { binDirectory, home, platform: "linux" });
        assert.equal(await readlink(command), resolve(root, "user-pi"));
        assert.equal(await readFile(extension, "utf8"), "export default function replacementExtension() {}\n");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("Pi integration old-install fallback removes only managed paths", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-pi-deactivate-"));
    const home = resolve(root, "home");
    const binDirectory = resolve(root, "bin");
    const missingSnapshot = resolve(root, "missing-original.json");
    const command = resolve(binDirectory, "pi");
    const extension = resolve(home, ".pi", "agent", "extensions", "devshell.js");
    try {
        await mkdir(binDirectory, { recursive: true });
        await mkdir(resolve(extension, ".."), { recursive: true });
        await writeFile(command, [
            "#!/usr/bin/env node",
            "if (process.env.DEVSHELL_PI_BUILTIN_TOOLS !== \"1\") process.argv.push(\"--no-builtin-tools\");",
            "await import(\"file:///old/node_modules/@earendil-works/pi-coding-agent/dist/cli.js\");",
            ""
        ].join("\n"), "utf8");
        await writeFile(extension, [
            "export { default } from \"file:///old/node_modules/@portable-devshell/pi-extension/dist/index.js\";",
            "export * from \"file:///old/node_modules/@portable-devshell/pi-extension/dist/index.js\";",
            ""
        ].join("\n"), "utf8");

        assert.deepEqual(await deactivatePiIntegration(missingSnapshot, { binDirectory, home, platform: "linux" }), {
            restoredOriginal: false
        });
        await assert.rejects(() => readFile(command), /ENOENT/u);
        await assert.rejects(() => readFile(extension), /ENOENT/u);

        await writeFile(command, "#!/bin/sh\necho user-pi\n", "utf8");
        await writeFile(extension, "export default function userExtension() {}\n", "utf8");
        await deactivatePiIntegration(missingSnapshot, { binDirectory, home, platform: "linux" });
        assert.equal(await readFile(command, "utf8"), "#!/bin/sh\necho user-pi\n");
        assert.equal(await readFile(extension, "utf8"), "export default function userExtension() {}\n");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});
