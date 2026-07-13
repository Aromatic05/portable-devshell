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
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const outputDirectory = resolve(
    repoRoot,
    readOption("--output-dir") ?? "release-assets",
);
const packageJson = JSON.parse(
    await readFile(resolve(repoRoot, "package.json"), "utf8"),
);
const version = requireString(packageJson.version, "package.json version");
const stagingRoot = await mkdtemp(resolve(tmpdir(), "portable-devshell-app-"));
const appDirectory = resolve(stagingRoot, "app");
const assetPath = resolve(outputDirectory, "portable-devshell-app.tar.gz");

try {
    await mkdir(outputDirectory, { recursive: true });
    runPnpm([
        "--config.node-linker=hoisted",
        "--filter",
        "@portable-devshell/cli",
        "--prod",
        "deploy",
        appDirectory,
    ]);
    await chmod(resolve(appDirectory, "dist", "cli", "CliMain.js"), 0o755);
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
        `${sha256}  portable-devshell-app.tar.gz\n`,
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
    run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", commandArgs);
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
