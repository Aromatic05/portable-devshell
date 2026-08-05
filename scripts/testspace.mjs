import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    buildTestspaceGlobalConfig,
    buildTestspaceInstanceConfig,
    resolveTestspaceInvocation,
    TESTSPACE_INSTANCE,
    testspaceUrls,
} from "./testspace/TestspaceConfig.mjs";
import { runConnectorLoop } from "./testspace/TestspaceConnector.mjs";
import { runTestspaceWebSmoke } from "./testspace/TestspaceWebSmoke.mjs";
import {
    createTestspaceProcessEnvironment,
    removeTestspaceDockerContainers,
    resetTestspacePodmanStorage,
    resolveTestspaceRuntimeDirectory,
    stopTestspaceTmux,
} from "./testspace/TestspaceRuntime.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(process.env.DEVSHELL_TESTSPACE_ROOT ?? join(repoRoot, ".testspace"));
const paths = {
    connectorLog: join(root, "connector.jsonl"),
    connectorPid: join(root, "connector.pid"),
    connectorProcessLog: join(root, "connector-process.log"),
    controlConfig: join(root, "home", ".devshell", "control", "config.toml"),
    home: join(root, "home"),
    instanceConfig: join(root, "home", ".devshell", "control", "instances", `${TESTSPACE_INSTANCE}.toml`),
    instanceConfigDirectory: join(root, "home", ".devshell", "control", "instances"),
    legacyRuntime: join(root, "runtime"),
    runtime: resolveTestspaceRuntimeDirectory(root),
    state: join(root, "state.json"),
    stopFile: join(root, "connector.stop"),
    workspace: join(root, "workspace"),
};

const { args, command } = resolveTestspaceInvocation(process.argv.slice(2));

switch (command) {
    case "start":
        await start(args);
        break;
    case "tui":
        await tui();
        break;
    case "web":
        await web(args);
        break;
    case "web-smoke":
        await webSmoke();
        break;
    case "stop":
        await stop();
        break;
    case "connector-loop":
        await connectorLoop(args);
        break;
    default:
        usage(`Unknown testspace command: ${command}`);
}

async function start(argv) {
    const intervalMs = readIntegerFlag(argv, "--interval-ms", 2000, 250, 60000);
    const skipBuild = argv.includes("--skip-build");
    const existing = await readState();
    if (existing !== undefined && isProcessAlive(existing.controlPid)) {
        const runtimeDirectory = stateRuntimeDirectory(existing);
        if (!isProcessAlive(existing.connectorPid)) {
            existing.connectorPid = await startConnector(testspaceEnvironment(runtimeDirectory));
            await writeState(existing);
            process.stdout.write("testspace connector was restarted.\n");
        } else {
            process.stdout.write("testspace is already running.\n");
        }
        printCommands(existing);
        return;
    }

    await stopConnector(existing?.connectorPid ?? await readOptionalConnectorPid());

    if (!skipBuild) {
        run("pnpm", ["build"]);
        run("pnpm", ["test:prepare"]);
    }
    await requireFile(cliEntry(), "run `pnpm build` first");
    await requireFile(workerPath(), "run `pnpm test:prepare` first");

    const previousRuntime = stateRuntimeDirectory(existing);
    const orphanControlPid = await readOptionalControlPid();
    if (existing === undefined && isProcessAlive(orphanControlPid)) {
        const orphanEnvironment = testspaceEnvironment(previousRuntime);
        runCli(["instance", "stop", TESTSPACE_INSTANCE], orphanEnvironment, {
            allowFailure: true,
        });
        runCli(["stop"], orphanEnvironment, { allowFailure: true });
    }

    stopTestspaceTmux(previousRuntime, TESTSPACE_INSTANCE);
    removeTestspaceDockerContainers(paths.instanceConfigDirectory);
    resetTestspacePodmanStorage(paths.home, previousRuntime);
    await rm(root, { force: true, recursive: true });
    await Promise.all(runtimeDirectories(previousRuntime).map(async (directory) =>
        await rm(directory, { force: true, recursive: true })
    ));

    await rm(paths.stopFile, { force: true });
    await Promise.all([
        mkdir(join(paths.home, ".devshell", "control", "instances"), { recursive: true }),
        mkdir(paths.runtime, { recursive: true }),
        mkdir(paths.workspace, { recursive: true }),
    ]);
    await ensureWorkspace();

    const mcpPort = await reservePort(18790);
    const webPort = await reservePort(mcpPort === 18791 ? 18792 : 18791);
    await writeFile(paths.controlConfig, buildTestspaceGlobalConfig({ mcpPort, webPort }), "utf8");
    await writeFile(paths.instanceConfig, buildTestspaceInstanceConfig({ workspace: paths.workspace }), "utf8");

    const env = testspaceEnvironment();
    runCli(["start"], env);
    runCli(["instance", "start", TESTSPACE_INSTANCE], env);
    const controlPid = await readControlPid();
    const state = {
        connectorPid: undefined,
        controlPid,
        createdAt: new Date().toISOString(),
        intervalMs,
        mcpPort,
        root,
        runtimeDirectory: paths.runtime,
        webPort,
    };
    await writeState(state);

    state.connectorPid = await startConnector(env);
    await writeState(state);

    process.stdout.write("testspace started with a real Control, Worker, MCP and Web runtime.\n");
    printCommands(state);
}

async function tui() {
    const state = await requireRunningState();
    await requireFile(tuiEntry(), "run `pnpm build` first");
    const result = spawnSync(process.execPath, [tuiEntry()], {
        cwd: repoRoot,
        env: testspaceEnvironment(stateRuntimeDirectory(state)),
        stdio: "inherit",
    });
    if (result.status !== 0) {
        throw new Error(`testspace TUI exited with ${String(result.status)}`);
    }
}

async function web(argv) {
    const state = await requireRunningState();
    const url = testspaceUrls(state).web;
    process.stdout.write(`${url}\n`);
    if (argv.includes("--print")) return;
    const opener = process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "start", "", url]]
          : ["xdg-open", [url]];
    const result = spawnSync(opener[0], opener[1], { stdio: "ignore" });
    if (result.status !== 0) {
        process.stdout.write("Browser opener is unavailable; open the URL above manually.\n");
    }
}

async function webSmoke() {
    const state = await requireRunningState();
    const result = await runTestspaceWebSmoke({ webPort: state.webPort });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function stop() {
    const state = await readState();
    const runtimeDirectory = stateRuntimeDirectory(state);
    let controlPid = state?.controlPid;
    if (state === undefined) {
        await stopConnector(await readOptionalConnectorPid());
        const orphanControlPid = await readOptionalControlPid();
        controlPid = orphanControlPid;
        if (isProcessAlive(orphanControlPid)) {
            const env = testspaceEnvironment(runtimeDirectory);
            runCli(["instance", "stop", TESTSPACE_INSTANCE], env, { allowFailure: true, inherit: true });
            runCli(["stop"], env, { allowFailure: true, inherit: true });
        }
    } else {
        await writeFile(paths.stopFile, "stop\n", "utf8");
        await stopConnector(state.connectorPid);
        const env = testspaceEnvironment(runtimeDirectory);
        runCli(["instance", "stop", TESTSPACE_INSTANCE], env, { allowFailure: true, inherit: true });
        runCli(["stop"], env, { allowFailure: true, inherit: true });
    }
    await waitForProcessExit(controlPid, 3_000);
    if (isProcessAlive(controlPid)) {
        throw new Error(`testspace control process ${String(controlPid)} is still running`);
    }
    stopTestspaceTmux(runtimeDirectory, TESTSPACE_INSTANCE);
    removeTestspaceDockerContainers(paths.instanceConfigDirectory);
    resetTestspacePodmanStorage(paths.home, runtimeDirectory);
    await Promise.all([
        rm(root, { force: true, recursive: true }),
        ...runtimeDirectories(runtimeDirectory).map(async (directory) =>
            await rm(directory, { force: true, recursive: true })
        ),
    ]);
    process.stdout.write("testspace stopped and removed.\n");
}

async function startConnector(env) {
    await rm(paths.stopFile, { force: true });
    const logFd = openSync(paths.connectorProcessLog, "a");
    const connector = spawn(process.execPath, [fileURLToPath(import.meta.url), "connector-loop"], {
        cwd: repoRoot,
        detached: true,
        env,
        stdio: ["ignore", logFd, logFd],
    });
    connector.unref();
    closeSync(logFd);
    await writeFile(paths.connectorPid, `${connector.pid}\n`, "utf8");
    return connector.pid;
}

async function stopConnector(pid) {
    if (isProcessAlive(pid)) {
        process.kill(pid, "SIGTERM");
        const deadline = Date.now() + 3000;
        while (isProcessAlive(pid) && Date.now() < deadline) {
            await delay(25);
        }
        if (isProcessAlive(pid)) {
            throw new Error(`testspace connector process ${String(pid)} did not stop`);
        }
    }
    await rm(paths.connectorPid, { force: true });
}

async function connectorLoop() {
    const state = await readState();
    if (state === undefined) throw new Error("missing testspace state");
    await runConnectorLoop({
        endpoint: testspaceUrls(state).mcp,
        intervalMs: state.intervalMs,
        logFile: paths.connectorLog,
        seed: process.env.DEVSHELL_TESTSPACE_SEED,
        stopFile: paths.stopFile,
    });
}

function runCli(cliArgs, env, options = {}) {
    const result = spawnSync(process.execPath, [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(sourceLoader()).href,
        cliEntry(),
        ...cliArgs,
    ], {
        cwd: repoRoot,
        encoding: options.inherit ? undefined : "utf8",
        env,
        stdio: options.inherit ? "inherit" : "pipe",
        timeout: 60000,
    });
    if (!options.allowFailure && result.status !== 0) {
        throw new Error(`devshell ${cliArgs.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    }
    return result;
}

function run(executable, commandArgs) {
    const result = spawnSync(executable, commandArgs, {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
    });
    if (result.status !== 0) throw new Error(`${executable} ${commandArgs.join(" ")} failed`);
}

function testspaceEnvironment(runtimeDirectory = paths.runtime) {
    return {
        ...createTestspaceProcessEnvironment(paths.home, runtimeDirectory),
        PORTABLE_DEVSHELL_HOME: join(paths.home, ".devshell"),
        [workerEnvironmentName()]: workerPath(),
    };
}

function stateRuntimeDirectory(state) {
    return typeof state?.runtimeDirectory === "string" && state.runtimeDirectory.length > 0
        ? state.runtimeDirectory
        : paths.legacyRuntime;
}

function runtimeDirectories(primary) {
    return [...new Set([primary, paths.runtime, paths.legacyRuntime])];
}

async function waitForProcessExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (isProcessAlive(pid) && Date.now() < deadline) {
        await delay(25);
    }
}

function workerEnvironmentName() {
    const os = { darwin: "DARWIN", linux: "LINUX", win32: "WINDOWS" }[process.platform];
    const arch = { arm64: "ARM64", x64: "X64" }[process.arch];
    if (os === undefined || arch === undefined) throw new Error(`unsupported host: ${process.platform}-${process.arch}`);
    return `PORTABLE_DEVSHELL_WORKER_${os}_${arch}_PATH`;
}

function workerPath() {
    const configured = process.env.PORTABLE_DEVSHELL_TEST_WORKER_PATH;
    if (configured !== undefined && configured.length > 0) {
        return resolve(repoRoot, configured);
    }
    const targetDirectory = resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? "target");
    return resolve(
        targetDirectory,
        "debug",
        `devshell-worker${process.platform === "win32" ? ".exe" : ""}`,
    );
}

function cliEntry() {
    return resolve(repoRoot, "packages", "cli", "src", "CliMain.ts");
}

function sourceLoader() {
    return resolve(repoRoot, "packages", "mcp", "test", "RegisterWorkspacePackages.mjs");
}

function tuiEntry() {
    return resolve(repoRoot, "scripts", "testspace", "TestspaceTui.mjs");
}

async function ensureWorkspace() {
    const readme = [
        "# portable-devshell testspace",
        "",
        "This workspace is isolated and may be modified by the testspace GPT-style connector simulator.",
        "All generated tool calls are limited to harmless reads, short shell output, Todo updates and short tmux tasks.",
        "",
    ].join("\n");
    await writeFile(join(paths.workspace, "README.md"), readme, "utf8");
    await writeFile(join(paths.workspace, "activity.txt"), "testspace activity\n", "utf8");
}

async function reservePort(preferred) {
    for (let port = preferred; port < preferred + 100; port += 1) {
        if (await portAvailable(port)) return port;
    }
    throw new Error(`unable to reserve a port near ${preferred}`);
}

function portAvailable(port) {
    return new Promise((resolvePromise) => {
        const server = createServer();
        server.once("error", () => resolvePromise(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
    });
}

async function readControlPid() {
    const pid = await readOptionalControlPid();
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error("control started without publishing a valid pid");
    }
    return pid;
}

async function readOptionalControlPid() {
    const pidPath = join(paths.home, ".devshell", "control", "control.pid");
    try {
        return Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    } catch {
        return undefined;
    }
}

async function readOptionalConnectorPid() {
    try {
        return Number.parseInt((await readFile(paths.connectorPid, "utf8")).trim(), 10);
    } catch {
        return undefined;
    }
}

async function writeState(state) {
    await writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readState() {
    try {
        return JSON.parse(await readFile(paths.state, "utf8"));
    } catch {
        return undefined;
    }
}

async function requireRunningState() {
    const state = await readState();
    if (state === undefined || !isProcessAlive(state.controlPid)) {
        throw new Error("testspace is not running; run `pnpm testspace start`");
    }
    return state;
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function delay(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function requireFile(path, hint) {
    try {
        await access(path);
    } catch {
        throw new Error(`missing ${path}; ${hint}`);
    }
}

function readIntegerFlag(argv, name, fallback, minimum, maximum) {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    const value = Number.parseInt(argv[index + 1] ?? "", 10);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
}

function printCommands(state) {
    printUrls(state);
    process.stdout.write([
        "Observe TUI:  pnpm testspace tui",
        "Open Web:     pnpm testspace web",
        "Smoke Web:    pnpm testspace web-smoke",
        "Stop/remove:   pnpm testspace stop",
        "",
    ].join("\n"));
}

function printUrls(state) {
    const urls = testspaceUrls(state);
    process.stdout.write(`MCP: ${urls.mcp}\nWeb: ${urls.web}\n`);
}

function usage(message) {
    process.stderr.write(`${message}\n`);
    process.stderr.write("Usage: pnpm testspace [start|tui|web|web-smoke|stop] [options]\n");
    process.exit(2);
}
