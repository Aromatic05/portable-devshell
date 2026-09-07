import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPackageBinFile, readPackageBinPath, writePortableApplicationManifest } from "./application-layout.mjs";
import { resolvePnpmCommand } from "./PnpmCommand.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const outputDirectory = resolve(
    repoRoot,
    readOption("--output-dir") ?? "release-assets",
);
const target = readOption("--target") ?? hostTarget();
if (target !== hostTarget()) {
    throw new Error(`cannot package ${target} on ${hostTarget()}; install dependencies on the target platform first.`);
}
const packageJson = JSON.parse(
    await readFile(resolve(repoRoot, "package.json"), "utf8"),
);
const version = requireString(packageJson.version, "package.json version");
const stagingRoot = await mkdtemp(resolve(repoRoot, ".portable-devshell-app-"));
const appDirectory = resolve(stagingRoot, "app");
const deployDirectory = relative(repoRoot, appDirectory);
const assetName = `portable-devshell-app-${target}.tar.gz`;
const assetPath = resolve(outputDirectory, assetName);

try {
    await mkdir(outputDirectory, { recursive: true });
    runPnpm([
        "--config.node-linker=hoisted",
        "--filter=./packages/cli",
        "--prod",
        "deploy",
        "--legacy",
        deployDirectory,
    ]);
    await writePortableApplicationManifest(appDirectory, { minimumNodeMajor: 24, version });
    const cli = await assertPackageBinFile(await readPackageBinPath(appDirectory, "devshell"));
    await chmod(cli.absolutePath, 0o755);
    await writeFile(
        resolve(appDirectory, "portable-devshell-install.json"),
        `${JSON.stringify({ minimumNodeMajor: 24, version }, null, 2)}\n`,
        "utf8",
    );

    run("tar", ["--dereference", "-czf", assetPath, "-C", appDirectory, "."]);
    const sha256 = createHash("sha256")
        .update(await readFile(assetPath))
        .digest("hex");
    await writeFile(
        `${assetPath}.sha256`,
        `${sha256}  ${assetName}\n`,
        "utf8",
    );
    process.stdout.write(`${assetPath}\n${assetPath}.sha256\n`);
} finally {
    await rm(stagingRoot, { force: true, recursive: true });
}

function readOption(name) {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
    }
    return value;
}

function runPnpm(commandArgs) {
    const command = resolvePnpmCommand();
    run(command.command, [...command.args, ...commandArgs]);
}

function run(command, commandArgs) {
    const result = spawnSync(command, commandArgs, {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
    });
    if (result.status !== 0) {
        throw new Error(
            `${command} ${commandArgs.join(" ")} failed with exit code ${result.status ?? "unknown"}.`,
        );
    }
}

function requireString(value, name) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${name} must be a non-empty string.`);
    }
    return value;
}

function hostTarget() {
    const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
    if (arch === undefined) {
        throw new Error(`unsupported host architecture: ${process.arch}`);
    }
    return `${os}-${arch}`;
}
