import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { assertPackageBinFile, readPackageBinPath } from "./application-layout.mjs";

const archiveArgument = process.argv.slice(2).find((argument) => argument !== "--");
if (archiveArgument === undefined) {
    throw new Error("usage: node scripts/smoke-package.mjs <portable-devshell-app.tar.gz>");
}

const archive = isAbsolute(archiveArgument) ? archiveArgument : resolve(process.cwd(), archiveArgument);
const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-package-smoke-"));
const app = resolve(root, "app");
const home = resolve(root, "home");
const runtime = resolve(root, "runtime");
const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: resolve(home, "AppData", "Local"),
    PORTABLE_DEVSHELL_HOME: resolve(home, ".devshell"),
    XDG_RUNTIME_DIR: runtime
};
let command;
let controlStarted = false;

try {
    await mkdir(app, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(runtime, { recursive: true });
    run("tar", ["-xzf", archive, "-C", app]);
    await assertNoSymlinks(app);

    const cli = await assertPackageBinFile(await readPackageBinPath(app, "devshell"));
    command = await createInstalledCommand(root, cli.absolutePath);

    smokeNativePty(app);

    assertCommandOutput(
        runInstalled(command, ["status"], environment),
        "control: stopped",
        "initial packaged status"
    );

    assertCommandOutput(
        runInstalled(command, ["start"], environment),
        "control: running",
        "packaged control start"
    );
    controlStarted = true;

    assertCommandOutput(
        runInstalled(command, ["status"], environment),
        "control: running",
        "running packaged status"
    );
    assertCommandOutput(
        runInstalled(command, ["logs"], environment),
        "control server started",
        "packaged control logs"
    );

    runInstalled(command, ["stop"], environment);
    controlStarted = false;
    assertCommandOutput(
        runInstalled(command, ["status"], environment),
        "control: stopped",
        "stopped packaged status"
    );

    process.stdout.write("package smoke passed\n");
} finally {
    if (controlStarted && command !== undefined) {
        runInstalled(command, ["stop"], environment, true);
    }
    await rm(root, { force: true, recursive: true });
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
            throw new Error(`portable app archive contains a symbolic link: ${path}`);
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
        windowsHide: true
    });
    if (result.error !== undefined && !ignoreFailure) {
        throw result.error;
    }
    if (result.status !== 0 && !ignoreFailure) {
        throw new Error(
            `packaged devshell ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.stdout ?? ""}${result.stderr ?? ""}`
        );
    }
    return {
        status: result.status,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? ""
    };
}

function assertCommandOutput(result, expected, stage) {
    if (result.status !== 0 || !result.stdout.includes(expected)) {
        throw new Error(
            `${stage} did not contain ${JSON.stringify(expected)} (${result.status ?? "unknown"})\n${result.stdout}${result.stderr}`
        );
    }
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.stdout}${result.stderr}`);
    }
}

function smokeNativePty(applicationDirectory) {
    const requireFromApplication = createRequire(resolve(applicationDirectory, "package.json"));
    const nodePtyPath = requireFromApplication.resolve("node-pty");
    const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "echo package-pty-ok"] : ["-c", "printf package-pty-ok"];
    const result = spawnSync(process.execPath, ["-e", [
        `const { spawn } = require(${JSON.stringify(nodePtyPath)});`,
        `const pty = spawn(${JSON.stringify(shell)}, ${JSON.stringify(args)}, { cols: 80, rows: 24 });`,
        "let output = '';",
        "let settled = false;",
        "let dataSubscription;",
        "let exitSubscription;",
        "const timeout = setTimeout(() => finish(1), 10000);",
        "function finish(code) {",
        "  if (settled) return;",
        "  settled = true;",
        "  clearTimeout(timeout);",
        "  dataSubscription?.dispose();",
        "  exitSubscription?.dispose();",
        "  try { pty.kill(); } catch {}",
        "  process.exit(code);",
        "}",
        "dataSubscription = pty.onData((data) => {",
        "  output += data;",
        "  if (output.includes('package-pty-ok')) finish(0);",
        "});",
        "exitSubscription = pty.onExit(({ exitCode }) => {",
        "  finish(exitCode === 0 && output.includes('package-pty-ok') ? 0 : 1);",
        "});"
    ].join("\n")], { encoding: "utf8", timeout: 15_000 });
    if (result.error !== undefined || result.status !== 0) {
        throw new Error(`packaged node-pty smoke failed (${result.status ?? "unknown"})\n${result.stderr ?? ""}`);
    }
}
