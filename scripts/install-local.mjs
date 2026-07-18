import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPackageBinFile, readPackageBinPath, writePortableApplicationManifest, tryReadPackageBinPath } from "./application-layout.mjs";

const installStepTotal = 5;
let installStep = 0;

function beginStep(message) {
    installStep += 1;
    process.stdout.write(`\n[${installStep}/${installStepTotal}] ${message}\n`);
}

function writeDetail(message) {
    process.stdout.write(`  ${message}\n`);
}

class WorkerReleaseIntegrityError extends Error {
    constructor(message) {
        super(message);
        this.name = "WorkerReleaseIntegrityError";
    }
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const version = requireString(packageJson.version, "package.json version");
const releaseTag = process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_TAG || `v${version}`;
const releaseBaseUrl = resolveReleaseBaseUrl();
const home = process.env.HOME || homedir();
const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32"
        ? process.env.LOCALAPPDATA || resolve(home, "AppData", "Local")
        : resolve(home, ".local", "share"));
const installRoot = process.env.PORTABLE_DEVSHELL_INSTALL_ROOT || resolve(dataHome, "portable-devshell");
const binDirectory = process.env.PORTABLE_DEVSHELL_BIN_DIR || resolve(home, ".local", "bin");
const devshellHome = process.env.PORTABLE_DEVSHELL_HOME || resolve(home, ".devshell");
const versionsDirectory = resolve(installRoot, "versions");
const versionDirectory = resolve(versionsDirectory, version);
const stagingDirectory = resolve(installRoot, `.staging-${version}-${process.pid}`);
const backupDirectory = resolve(installRoot, `.backup-${version}-${process.pid}`);
const currentLink = resolve(installRoot, "current");
const commandLink = resolve(binDirectory, process.platform === "win32" ? "devshell.cmd" : "devshell");
const allTargets = [
    { key: "linux-x64", rustTarget: "x86_64-unknown-linux-musl" },
    { key: "linux-arm64", rustTarget: "aarch64-unknown-linux-musl" },
    { key: "darwin-x64", rustTarget: "x86_64-apple-darwin" },
    { key: "darwin-arm64", rustTarget: "aarch64-apple-darwin" },
    { key: "windows-x64", rustTarget: "x86_64-pc-windows-msvc" },
    { key: "windows-arm64", rustTarget: "aarch64-pc-windows-msvc" }
];
const hostTarget = resolveHostTarget();
const targets = allTargets.filter((target) => target.key === hostTarget);

await rm(stagingDirectory, { force: true, recursive: true });
await rm(backupDirectory, { force: true, recursive: true });
await mkdir(installRoot, { mode: 0o700, recursive: true });

try {
    beginStep("检查安装环境");
    writeDetail(`Node.js ${process.version}`);
    writeDetail(`宿主平台 ${hostTarget}`);
    writeDetail(`预装 Worker：${targets.map((target) => target.key).join(", ")}`);
    writeDetail("其他平台将在首次连接时按需下载");

    beginStep("构建并验证应用");
    runPnpm(["build"]);
    runPnpm(["--filter", "@portable-devshell/cli", "--prod", "deploy", stagingDirectory]);
    await writePortableApplicationManifest(stagingDirectory, { minimumNodeMajor: 24, version });
    const stagingCli = await assertPackageBinFile(await readPackageBinPath(stagingDirectory, "devshell"));
    if (process.platform !== "win32") await chmod(stagingCli.absolutePath, 0o755);
    await assertCliStarts(stagingCli.absolutePath, "安装前验证失败");
    writeDetail("CLI 入口和运行时依赖验证通过");

    beginStep(`准备预装 Worker（${targets.length} 个）`);
    const installedWorkers = {};
    for (const target of targets) {
        writeDetail(`准备 ${target.key}`);
        installedWorkers[target.key] = await installWorkerRemoteFirst(target);
    }
    await activateHostWorker();

    await writeFile(
        resolve(stagingDirectory, "portable-devshell-install.json"),
        `${JSON.stringify({
            releaseTag,
            version,
            workerReleaseDirectoryUrl: `${releaseBaseUrl}/${releaseTag}`,
            workers: installedWorkers
        }, null, 2)}\n`,
        { mode: 0o600 }
    );

    beginStep("停止旧版本并切换安装");
    await stopInstalledControl();
    await mkdir(versionsDirectory, { mode: 0o700, recursive: true });

    const previousActivation = await captureApplicationActivation();
    if (await pathExists(versionDirectory)) {
        await rename(versionDirectory, backupDirectory);
    }

    try {
        await rename(stagingDirectory, versionDirectory);
        await activateApplication(versionDirectory);
        beginStep("验证安装结果");
        await assertInstalledCommandStarts();
    } catch (error) {
        await rm(versionDirectory, { force: true, recursive: true });
        if (await pathExists(backupDirectory)) {
            await rename(backupDirectory, versionDirectory);
        }
        await restoreApplicationActivation(previousActivation);
        throw error;
    }

    await rm(backupDirectory, { force: true, recursive: true });
    writeDetail("已安装命令可以正常启动");
    process.stdout.write(
        [
            "",
            `已安装 portable-devshell ${version}。`,
            `命令：${commandLink}`,
            `已预装 Worker：${targets.map((target) => target.key).join(", ")}`,
            "其他 Worker：首次连接对应平台时按需下载并校验",
            "下一步：",
            `  ${commandLink} start`,
            `  ${commandLink} tui`,
            process.env.PATH?.split(delimiter).includes(binDirectory)
                ? ""
                : `PATH 尚未包含 ${binDirectory}，请将它加入 shell 配置。`
        ]
            .filter(Boolean)
            .join("\n") + "\n"
    );
} catch (error) {
    await rm(stagingDirectory, { force: true, recursive: true });
    throw error;
}

async function installWorkerRemoteFirst(target) {
    try {
        return await installReleaseWorker(target);
    } catch (releaseError) {
        if (releaseError instanceof WorkerReleaseIntegrityError) {
            throw releaseError;
        }

        process.stderr.write(
            `Release 中无法取得 ${target.key}，尝试本地构建。\n${formatError(releaseError)}\n`
        );

        try {
            return await installSourceWorker(target);
        } catch (buildError) {
            throw new Error(
                [
                    `无法安装 ${target.key} worker。`,
                    `Release 下载失败：${formatError(releaseError)}`,
                    `本地构建失败：${formatError(buildError)}`
                ].join("\n"),
                { cause: buildError }
            );
        }
    }
}

async function installReleaseWorker(target) {
    const assetName = workerAssetName(target);
    const releaseDirectory = `${releaseBaseUrl}/${releaseTag}`;
    writeDetail(`下载 ${assetName}.sha256`);
    const expectedSha = await fetchSha256(`${releaseDirectory}/${assetName}.sha256`);
    writeDetail(`下载 ${assetName}`);
    const payload = Buffer.from(await fetchBytes(`${releaseDirectory}/${assetName}`));
    const actualSha = createHash("sha256").update(payload).digest("hex");
    if (actualSha !== expectedSha) {
        throw new WorkerReleaseIntegrityError(
            `Checksum mismatch for ${assetName}: expected ${expectedSha}, got ${actualSha}.`
        );
    }

    return await installWorkerBytes(target, payload, expectedSha, "release");
}

async function installSourceWorker(target) {
    const outputDirectory = resolve(installRoot, `.worker-build-${target.key}-${process.pid}`);
    await rm(outputDirectory, { force: true, recursive: true });

    try {
        run("rustup", ["target", "add", target.rustTarget]);
        runNode([
            "./scripts/build-worker.mjs",
            target.key,
            "--output-dir",
            outputDirectory
        ]);

        const assetName = workerAssetName(target);
        const payload = await readFile(resolve(outputDirectory, assetName));
        return await installWorkerBytes(target, payload, undefined, "local-build");
    } finally {
        await rm(outputDirectory, { force: true, recursive: true });
    }
}

async function installWorkerBytes(target, payload, expectedSha, source) {
    const sha256 = expectedSha ?? createHash("sha256").update(payload).digest("hex");
    const assetName = workerAssetName(target);
    const binaryName = workerBinaryName(target);
    const installDirectory = resolve(devshellHome, "workers", target.key, sha256);
    const binaryPath = resolve(installDirectory, binaryName);
    const shaPath = resolve(installDirectory, `${binaryName}.sha256`);

    await mkdir(installDirectory, { mode: 0o700, recursive: true });
    if ((await readInstalledSha(binaryPath, shaPath)) !== sha256) {
        const temporaryBinary = `${binaryPath}.tmp-${process.pid}`;
        const temporarySha = `${shaPath}.tmp-${process.pid}`;
        await writeFile(temporaryBinary, payload, target.key.startsWith("windows-") ? {} : { mode: 0o755 });
        if (!target.key.startsWith("windows-")) await chmod(temporaryBinary, 0o755);
        await writeFile(temporarySha, `${sha256}\n`, target.key.startsWith("windows-") ? {} : { mode: 0o600 });
        await rename(temporaryBinary, binaryPath);
        await rename(temporarySha, shaPath);
    }

    const workerBinDirectory = resolve(devshellHome, "bin");
    await mkdir(workerBinDirectory, { mode: 0o700, recursive: true });
    const activePath = resolve(workerBinDirectory, assetName);
    if (process.platform === "win32") {
        await copyFile(binaryPath, activePath);
    } else {
        await replaceSymlink(activePath, `../workers/${target.key}/${sha256}/${binaryName}`);
    }

    return { path: binaryPath, sha256, source };
}

async function activateHostWorker() {
    const hostTarget = resolveHostTarget();
    const workerBinDirectory = resolve(devshellHome, "bin");
    if (process.platform === "win32") {
        await copyFile(
            resolve(workerBinDirectory, workerAssetName({ key: hostTarget })),
            resolve(workerBinDirectory, "devshell-worker.exe")
        );
    } else {
        await replaceSymlink(resolve(workerBinDirectory, "devshell-worker"), `devshell-worker-${hostTarget}`);
    }
}

async function activateApplication(versionDirectory) {
    const cli = await assertPackageBinFile(await readPackageBinPath(versionDirectory, "devshell"));
    await mkdir(binDirectory, { recursive: true });
    if (process.platform === "win32") {
        await replaceSymlink(currentLink, versionDirectory, "junction");
        const cliPath = resolve(currentLink, cli.relativePath);
        await writeFile(commandLink, `@echo off\r\nnode "${cliPath}" %*\r\n`, "utf8");
    } else {
        await replaceSymlink(currentLink, `versions/${version}`);
        await replaceSymlink(commandLink, resolve(currentLink, cli.relativePath));
    }
}

async function captureApplicationActivation() {
    return {
        commandContent: process.platform === "win32" ? await readFileIfExists(commandLink) : undefined,
        commandTarget: process.platform === "win32" ? undefined : await readlinkIfExists(commandLink),
        currentTarget: await readlinkIfExists(currentLink)
    };
}

async function restoreApplicationActivation(previous) {
    await rm(currentLink, { force: true, recursive: process.platform === "win32" });
    await rm(commandLink, { force: true });
    if (previous.currentTarget !== undefined) {
        await symlink(previous.currentTarget, currentLink, process.platform === "win32" ? "junction" : undefined);
    }
    if (process.platform === "win32") {
        if (previous.commandContent !== undefined) {
            await writeFile(commandLink, previous.commandContent, "utf8");
        }
    } else if (previous.commandTarget !== undefined) {
        await symlink(previous.commandTarget, commandLink);
    }
}

async function assertCliStarts(cliPath, failureLabel) {
    await assertCommandStarts(process.execPath, [cliPath, "status"], false, failureLabel);
}

async function assertInstalledCommandStarts() {
    await assertCommandStarts(commandLink, ["status"], process.platform === "win32", "安装结果验证失败");
}

async function assertCommandStarts(command, args, shell, failureLabel) {
    const smokeRoot = await mkdtemp(join(tmpdir(), "portable-devshell-install-smoke-"));
    const smokeRuntime = resolve(smokeRoot, "runtime");
    try {
        await mkdir(smokeRuntime, { recursive: true });
        const result = spawnSync(command, args, {
            cwd: smokeRoot,
            encoding: "utf8",
            env: {
                ...process.env,
                HOME: smokeRoot,
                USERPROFILE: smokeRoot,
                LOCALAPPDATA: resolve(smokeRoot, "AppData", "Local"),
                PORTABLE_DEVSHELL_HOME: resolve(smokeRoot, ".devshell"),
                XDG_RUNTIME_DIR: smokeRuntime
            },
            shell,
            windowsHide: true
        });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        if (result.error !== undefined || result.status !== 0 || !output.includes("control: stopped")) {
            throw new Error(`${failureLabel}：CLI 无法正常执行 status。\n${result.error?.stack ?? output}`);
        }
    } finally {
        await rm(smokeRoot, { force: true, recursive: true });
    }
}

async function readlinkIfExists(path) {
    try {
        return await readlink(path);
    } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
    }
}

async function readFileIfExists(path) {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
    }
}

async function stopInstalledControl() {
    const currentCli = await tryReadPackageBinPath(currentLink, "devshell");
    const pidFile = resolve(devshellHome, "control", "control.pid");
    if (currentCli !== undefined && await pathExists(currentCli.absolutePath)) {
        const result = spawnSync(process.execPath, [currentCli.absolutePath, "stop"], {
            cwd: home,
            encoding: "utf8",
            env: process.env
        });
        if (result.status === 0 && !(await pathExists(pidFile))) {
            return;
        }
        process.stderr.write(
            `Installed CLI did not fully stop control; attempting verified PID recovery.\n${result.stderr || result.stdout || ""}`
        );
    }

    if (!(await pathExists(pidFile))) {
        return;
    }

    const pidSource = (await readFile(pidFile, "utf8")).trim();
    const pid = Number.parseInt(pidSource, 10);
    if (!/^[1-9][0-9]*$/u.test(pidSource) || !Number.isSafeInteger(pid)) {
        throw new Error(`Cannot recover control shutdown because ${pidFile} contains an invalid PID.`);
    }

    if (!isProcessRunning(pid)) {
        await cleanupControlRuntime(pidFile);
        return;
    }

    const commandLine = readProcessCommandLine(pid);
    if (!isPortableDevshellControlCommand(commandLine)) {
        throw new Error(
            `Refusing to terminate PID ${pid}: the process named by ${pidFile} is not a verified portable-devshell ControlDaemon.js process.`
        );
    }

    if (signalProcess(pid, "SIGTERM") && !(await waitForProcessExit(pid, 5_000))) {
        if (signalProcess(pid, "SIGKILL") && !(await waitForProcessExit(pid, 2_000))) {
            throw new Error(`Verified portable-devshell control PID ${pid} did not terminate.`);
        }
    }
    await cleanupControlRuntime(pidFile);
}

function readProcessCommandLine(pid) {
    if (process.platform === "win32") {
        const result = spawnSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`
            ],
            { encoding: "utf8", windowsHide: true }
        );
        return result.status === 0 ? result.stdout.trim() : "";
    }

    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "";
}

function isPortableDevshellControlCommand(commandLine) {
    return commandLine.includes("ControlDaemon.js") && commandLine.toLowerCase().includes("portable-devshell");
}

function signalProcess(pid, signal) {
    try {
        process.kill(pid, signal);
        return true;
    } catch (error) {
        if (error?.code === "ESRCH") {
            return false;
        }
        throw error;
    }
}

function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === "ESRCH") {
            return false;
        }
        throw error;
    }
}

async function waitForProcessExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessRunning(pid)) {
            return true;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    return !isProcessRunning(pid);
}

async function cleanupControlRuntime(pidFile) {
    await rm(pidFile, { force: true });
    if (process.platform === "win32") {
        return;
    }
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR
        ? join(process.env.XDG_RUNTIME_DIR, "portable-devshell")
        : join(tmpdir(), `portable-devshell-${typeof process.getuid === "function" ? process.getuid() : process.env.USER ?? process.env.USERNAME ?? "user"}`);
    await rm(join(runtimeDirectory, "control.sock"), { force: true });
}

function runPnpm(args) {
    run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args);
}

function runNode(args) {
    run(process.execPath, args);
}

function run(command, args) {
    const result = spawnSync(command, args, { cwd: repoRoot, env: process.env, stdio: "inherit" });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
    }
}


async function fetchSha256(url) {
    const text = Buffer.from(await fetchBytes(url)).toString("utf8");
    const sha = text.trim().split(/\s+/u)[0] || "";
    if (!/^[a-f0-9]{64}$/u.test(sha)) {
        throw new WorkerReleaseIntegrityError(`Invalid SHA-256 document from ${url}.`);
    }
    return sha;
}

async function fetchBytes(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
    }
    return await response.arrayBuffer();
}

async function readInstalledSha(binaryPath, shaPath) {
    try {
        const [binary, recorded] = await Promise.all([readFile(binaryPath), readFile(shaPath, "utf8")]);
        const actual = createHash("sha256").update(binary).digest("hex");
        return actual === recorded.trim() ? actual : undefined;
    } catch {
        return undefined;
    }
}

function workerBinaryName(target) {
    return target.key.startsWith("windows-") ? "devshell-worker.exe" : "devshell-worker";
}

function workerAssetName(target) {
    return target.key.startsWith("windows-")
        ? `devshell-worker-${target.key}.exe`
        : `devshell-worker-${target.key}`;
}

async function replaceSymlink(path, target, type = undefined) {
    const temporary = `${path}.tmp-${process.pid}`;
    await rm(temporary, { force: true, recursive: type === "junction" });
    await symlink(target, temporary, type);
    await rename(temporary, path).catch(async (error) => {
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
            throw error;
        }
        await rm(path, { force: true, recursive: type === "junction" });
        await rename(temporary, path);
    });
}

async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

function resolveReleaseBaseUrl() {
    const explicit = process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL;
    if (explicit) {
        return explicit.replace(/\/+$/u, "");
    }
    const repository = process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_REPOSITORY || "Aromatic05/portable-devshell";
    return `https://github.com/${repository.replace(/^\/+|\/+$/gu, "")}/releases/download`;
}

function resolveHostTarget() {
    const os =
        process.platform === "linux"
            ? "linux"
            : process.platform === "darwin"
              ? "darwin"
              : process.platform === "win32"
                ? "windows"
                : undefined;
    const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
    if (!os || !arch) {
        throw new Error(`Unsupported installation host: ${process.platform}-${process.arch}.`);
    }
    return `${os}-${arch}`;
}

function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}

function requireString(value, name) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${name} must be a non-empty string.`);
    }
    return value;
}
