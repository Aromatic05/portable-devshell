import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
    throw new Error("smoke-install-release-windows.mjs must run on Windows.");
}

const archiveArgument = process.argv.slice(2).find((argument) => argument !== "--");
if (archiveArgument === undefined) {
    throw new Error("usage: node scripts/smoke-install-release-windows.mjs <portable-devshell-app.tar.gz>");
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const archive = isAbsolute(archiveArgument) ? archiveArgument : resolve(process.cwd(), archiveArgument);
const target = hostTarget();
const workerName = `devshell-worker-${target}.exe`;
const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-windows-release-install-smoke-"));
const release = resolve(root, "release");
const home = resolve(root, "home");
const installRoot = resolve(root, "install");
const binDirectory = resolve(root, "bin");
const devshellHome = resolve(root, "devshell-home");
const runtime = resolve(root, "runtime");
const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: resolve(home, "AppData", "Local"),
    PORTABLE_DEVSHELL_HOME: devshellHome,
    PORTABLE_DEVSHELL_INSTALL_ROOT: installRoot,
    PORTABLE_DEVSHELL_BIN_DIR: binDirectory,
    PORTABLE_DEVSHELL_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/u, ""),
    XDG_RUNTIME_DIR: runtime
};
let controlStarted = false;

try {
    await mkdir(release, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(runtime, { recursive: true });

    for (const path of [archive, `${archive}.sha256`]) {
        await copyFile(path, resolve(release, basename(path)));
    }
    const worker = resolve(dirname(archive), workerName);
    for (const path of [worker, `${worker}.sha256`]) {
        await copyFile(path, resolve(release, basename(path)));
    }

    const install = run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve(repositoryRoot, "scripts", "install-release.ps1")
    ]);
    assert.equal(install.status, 0, `${install.stdout}${install.stderr}`);

    const command = resolve(binDirectory, "devshell.cmd");
    assertOutput(run(command, ["status"], true), "control: stopped", "installed status");
    assertOutput(run(command, ["start"], true), "control: running", "installed start");
    controlStarted = true;
    assertOutput(run(command, ["logs"], true), "control server started", "installed logs");
    assertOutput(run(command, ["stop"], true), "control: stopped", "installed stop");
    controlStarted = false;

    process.stdout.write("Windows release installer smoke passed\n");
} finally {
    if (controlStarted) {
        run(resolve(binDirectory, "devshell.cmd"), ["stop"], true, true);
    }
    await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
}

function hostTarget() {
    if (process.arch === "x64") return "windows-x64";
    if (process.arch === "arm64") return "windows-arm64";
    throw new Error(`unsupported Windows architecture: ${process.arch}`);
}

function run(executable, args, shell = false, ignoreFailure = false) {
    const result = spawnSync(executable, args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
        shell,
        timeout: 45_000,
        windowsHide: true
    });
    if (!ignoreFailure && (result.error !== undefined || result.status !== 0)) {
        throw new Error(`${executable} ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.error?.stack ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    }
    return {
        status: result.status,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? ""
    };
}

function assertOutput(result, expected, stage) {
    if (result.status !== 0 || !result.stdout.includes(expected)) {
        throw new Error(`${stage} did not contain ${JSON.stringify(expected)}\n${result.stdout}${result.stderr}`);
    }
}
