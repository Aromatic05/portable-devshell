import { spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";

import {
    assertPackageBinFile,
    readPackageBinPath,
} from "./application-layout.mjs";
import { resolveApplicationSmokeArchive } from "./smoke-artifact-arguments.mjs";
import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";

const archive = resolveApplicationSmokeArchive(process.argv.slice(2));
const root = await createTestTempDirectory("package-smoke");
const app = resolve(root, "app");
const home = resolve(root, "home");
const runtime = resolve(root, "runtime");
const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: resolve(home, "AppData", "Local"),
    PORTABLE_DEVSHELL_HOME: resolve(home, ".devshell"),
    XDG_RUNTIME_DIR: runtime,
};
let command;
let controlMayBeRunning = false;
let primaryFailure;

try {
    stage("extract application archive");
    await mkdir(app, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(runtime, { recursive: true });
    run("tar", ["-xzf", archive, "-C", app]);
    stage("verify packaged files");
    await assertNoSymlinks(app);

    const cli = await assertPackageBinFile(
        await readPackageBinPath(app, "devshell"),
    );
    command = await createInstalledCommand(root, cli.absolutePath);

    stage("check initial Control state");
    assertCommandOutput(
        runInstalled(command, ["status"], environment),
        "control: stopped",
        "initial packaged status",
    );

    // A timed-out start may still have launched Control. Cleanup must attempt
    // to stop it even if the start command never returned success.
    controlMayBeRunning = true;
    stage("start Control");
    assertCommandOutput(
        runInstalled(command, ["start"], environment),
        "control: running",
        "packaged control start",
    );

    stage("check running Control");
    assertCommandOutput(
        runInstalled(command, ["status"], environment),
        "control: running",
        "running packaged status",
    );
    stage("read Control startup logs");
    assertCommandOutput(
        runInstalled(command, ["logs"], environment),
        "control server started",
        "packaged control logs",
    );

    stage("stop Control");
    runInstalled(command, ["stop"], environment);
    controlMayBeRunning = false;
    stage("check stopped Control");
    assertCommandOutput(
        runInstalled(command, ["status"], environment),
        "control: stopped",
        "stopped packaged status",
    );

} catch (error) {
    primaryFailure = error;
}
const cleanupFailures = [];
if (controlMayBeRunning && command !== undefined) {
    try {
        const stopped = runInstalled(command, ["stop"], environment, true);
        if (stopped.status !== 0) {
            cleanupFailures.push(new Error(
                `packaged Control cleanup stop failed (${stopped.status ?? "unknown"})`,
            ));
        }
    } catch (error) {
        cleanupFailures.push(error);
    }
}
try {
    // Windows can report ENOTEMPTY while stopped Control releases its
    // extension-data handles. Retry only temporary file deletion.
    await rm(root, {
        force: true,
        maxRetries: 10,
        recursive: true,
        retryDelay: 100,
    });
} catch (error) {
    cleanupFailures.push(error);
}
if (primaryFailure !== undefined) {
    if (cleanupFailures.length > 0) {
        throw new AggregateError(
            [primaryFailure, ...cleanupFailures],
            "Package smoke failed; cleanup also failed.",
        );
    }
    throw primaryFailure;
}
if (cleanupFailures.length === 1) throw cleanupFailures[0];
if (cleanupFailures.length > 1)
    throw new AggregateError(cleanupFailures, "Package smoke cleanup failed.");
process.stdout.write("package smoke passed\n");

function stage(message) {
    process.stdout.write(`[package-smoke] ${message}\n`);
}

async function createInstalledCommand(root, cli) {
    if (process.platform === "win32") {
        return { executable: process.execPath, args: [cli] };
    }

    const bin = resolve(root, "bin");
    const executable = resolve(bin, "devshell");
    await mkdir(bin, { recursive: true });
    await symlink(cli, executable);
    return { executable, args: [] };
}

async function assertNoSymlinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
            throw new Error(
                `portable app archive contains a symbolic link: ${path}`,
            );
        }
        if (metadata.isDirectory()) {
            await assertNoSymlinks(path);
        }
    }
}

function runInstalled(command, args, env, ignoreFailure = false) {
    const result = spawnSync(command.executable, [...command.args, ...args], {
        encoding: "utf8",
        env,
        timeout: 30_000,
        windowsHide: true,
    });
    if (result.error !== undefined && !ignoreFailure) {
        throw result.error;
    }
    if (result.status !== 0 && !ignoreFailure) {
        throw new Error(
            `packaged devshell ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
        );
    }
    return {
        status: result.status,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? "",
    };
}

function assertCommandOutput(result, expected, stage) {
    if (result.status !== 0 || !result.stdout.includes(expected)) {
        throw new Error(
            `${stage} did not contain ${JSON.stringify(expected)} (${result.status ?? "unknown"})\n${result.stdout}${result.stderr}`,
        );
    }
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.stdout}${result.stderr}`,
        );
    }
}
