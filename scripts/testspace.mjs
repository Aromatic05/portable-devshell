import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    buildTestspaceGlobalConfig,
    buildTestspaceInstanceConfig,
    buildTestspaceReverseInstanceConfig,
    resolveTestspaceInvocation,
    TESTSPACE_INSTANCE,
    TESTSPACE_REVERSE_INSTANCE,
    testspaceUrls,
} from "./testspace/TestspaceConfig.mjs";
import {
    readTestspaceConnectorHealth,
    runConnectorLoop,
} from "./testspace/TestspaceConnector.mjs";
import {
    ensureConnectorProcesses,
    ensureInstanceReady,
    readConnectorStatuses,
    stopWorkerProcesses,
    waitForConnectorReady,
} from "./testspace/TestspaceLifecycle.mjs";
import {
    readTestspaceReverseStatus,
    startTestspaceReverse,
    stopTestspaceReverse,
    withTestspaceControlConnection,
} from "./testspace/TestspaceReverse.mjs";
import { runTestspaceTerminalSmoke } from "./testspace/TestspaceTerminalSmoke.mjs";
import { runTestspaceCommentSmoke } from "./testspace/TestspaceCommentSmoke.mjs";
import { runTestspaceWebSmoke } from "./testspace/TestspaceWebSmoke.mjs";
import {
    assertTestspaceRootOwned,
    createTestspaceProcessEnvironment,
    markTestspaceRootOwned,
    removeTestspaceDockerContainers,
    removeOwnedTestspaceRoot,
    resetTestspacePodmanStorage,
    resolveTestspaceRoot,
    resolveTestspaceRuntimeDirectory,
    stopTestspaceTmux,
} from "./testspace/TestspaceRuntime.mjs";
import {
    assertTestspaceExecutionContext,
    assertTestspaceLifecycleEnvironment,
    TESTSPACE_TOKEN_ENV,
} from "./testspace/TestspaceNamespace.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const root = resolveTestspaceRoot(repoRoot, process.env.DEVSHELL_TESTSPACE_ROOT);
const paths = {
    connectorHealth: join(root, "connector-health.json"),
    connectorLog: join(root, "connector.jsonl"),
    connectorPid: join(root, "connector.pid"),
    connectorProcessLog: join(root, "connector-process.log"),
    controlConfig: join(root, "home", ".devshell", "control", "config.toml"),
    home: join(root, "home"),
    instanceConfig: join(root, "home", ".devshell", "control", "instances", `${TESTSPACE_INSTANCE}.toml`),
    instanceConfigDirectory: join(root, "home", ".devshell", "control", "instances"),
    legacyRuntime: join(root, "runtime"),
    reverseDevshellHome: join(root, "reverse-home", ".devshell"),
    reverseConnectorHealth: join(root, "reverse-connector-health.json"),
    reverseConnectorLog: join(root, "reverse-connector.jsonl"),
    reverseConnectorPid: join(root, "reverse-connector.pid"),
    reverseConnectorProcessLog: join(root, "reverse-connector-process.log"),
    reverseConnectorStopFile: join(root, "reverse-connector.stop"),
    reverseHome: join(root, "reverse-home"),
    reverseInstanceConfig: join(root, "home", ".devshell", "control", "instances", `${TESTSPACE_REVERSE_INSTANCE}.toml`),
    reverseRuntime: join(root, "reverse-runtime"),
    reverseWorkspace: join(root, "reverse-workspace"),
    runtime: resolveTestspaceRuntimeDirectory(root),
    state: join(root, "state.json"),
    stopFile: join(root, "connector.stop"),
    workspace: join(root, "workspace"),
};

assertTestspaceExecutionContext(root);
await assertTestspaceRootOwned(repoRoot, root);

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
    case "comment-smoke":
        await commentSmoke();
        break;
    case "exec":
        await execInTestspace(args);
        break;
    case "status":
        await status();
        break;
    case "smoke":
        await smoke();
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
        const env = testspaceEnvironment(runtimeDirectory);
        let repaired = false;
        let stateChanged = false;
        const local = await ensureInstanceReady({
            instance: TESTSPACE_INSTANCE,
            readSnapshot: async (instance) =>
                await readTestspaceInstanceSnapshot(runtimeDirectory, instance),
            startInstance: async (instance) => {
                runCli(["instance", "start", instance], env);
                return await readTestspaceInstanceSnapshot(runtimeDirectory, instance);
            },
        });
        if (local.restarted) {
            repaired = true;
            process.stdout.write("testspace local Worker was restarted.\n");
        }
        const reverseStatus = await readTestspaceReverseStatus({
            instanceName: TESTSPACE_REVERSE_INSTANCE,
            runtimeDirectory,
        });
        if (!reverseStatus.ready || !reverseStatus.connected) {
            stopTestspaceReverse({
                environment: env,
                paths,
                workerPath: workerPath(),
            });
            existing.reverse = await startTestspaceReverse({
                controllerUrl: `http://127.0.0.1:${existing.mcpPort}`,
                environment: env,
                paths,
                runtimeDirectory,
                workerPath: workerPath(),
            });
            repaired = true;
            stateChanged = true;
            process.stdout.write("testspace reverse Worker was restarted.\n");
        }
        const connectors = await ensureConnectorProcesses(connectorTargets(existing), {
            isProcessAlive,
            readHealth: async (target) => await readTestspaceConnectorHealth(target.healthFile),
            readPid: readOptionalConnectorPid,
            restartConnector: async (target, pid) => {
                await stopConnector(target, pid);
                return await startConnector(target, env);
            },
            startConnector: async (target) => await startConnector(target, env),
        });
        for (const [instance, connector] of Object.entries(connectors)) {
            if (!connector.restarted) continue;
            repaired = true;
            process.stdout.write(`testspace activity connector was restarted for ${instance}.\n`);
        }
        if (!repaired) {
            process.stdout.write("testspace is already running.\n");
        }
        if (stateChanged) await writeState(existing);
        printCommands(existing);
        return;
    }

    await stopConnectorProcesses(connectorProcessTargets());

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
    stopTestspaceWorkerProcesses(previousRuntime);

    await stopTestspaceTmux({
        devshellHome: join(paths.home, ".devshell"),
        instanceName: TESTSPACE_INSTANCE,
        runtimeDirectory: previousRuntime,
        workspace: paths.workspace,
    });
    await stopTestspaceTmux({
        devshellHome: paths.reverseDevshellHome,
        instanceName: TESTSPACE_REVERSE_INSTANCE,
        runtimeDirectory: paths.reverseRuntime,
        workspace: paths.reverseWorkspace,
    });
    removeTestspaceDockerContainers(paths.instanceConfigDirectory);
    resetTestspacePodmanStorage(paths.home, previousRuntime);
    await removeOwnedTestspaceRoot(repoRoot, root);
    await Promise.all(runtimeDirectories(previousRuntime).map(async (directory) =>
        await rm(directory, { force: true, recursive: true })
    ));

    await markTestspaceRootOwned(repoRoot, root);
    await Promise.all(
        connectorProcessTargets().map(async (target) =>
            await rm(target.stopFile, { force: true })
        ),
    );
    await Promise.all([
        mkdir(join(paths.home, ".devshell", "control", "instances"), { recursive: true }),
        mkdir(paths.reverseHome, { recursive: true }),
        mkdir(paths.reverseRuntime, { recursive: true }),
        mkdir(paths.reverseWorkspace, { recursive: true }),
        mkdir(paths.runtime, { recursive: true }),
        mkdir(paths.workspace, { recursive: true }),
    ]);
    await Promise.all([
        ensureWorkspace(paths.workspace, "local"),
        ensureWorkspace(paths.reverseWorkspace, "reverse"),
    ]);

    const mcpPort = await reservePort(18790);
    const webPort = await reservePort(mcpPort === 18791 ? 18792 : 18791);
    await writeFile(paths.controlConfig, buildTestspaceGlobalConfig({ mcpPort, webPort }), "utf8");
    await writeFile(paths.instanceConfig, buildTestspaceInstanceConfig(), "utf8");
    await writeFile(
        paths.reverseInstanceConfig,
        buildTestspaceReverseInstanceConfig(),
        "utf8",
    );

    const env = testspaceEnvironment();
    runCli(["start"], env);
    runCli(["instance", "start", TESTSPACE_INSTANCE], env);
    const controlPid = await readControlPid();
    let reverse;
    try {
        reverse = await startTestspaceReverse({
            controllerUrl: `http://127.0.0.1:${mcpPort}`,
            environment: env,
            paths,
            runtimeDirectory: paths.runtime,
            workerPath: workerPath(),
        });
    } catch (error) {
        runCli(["instance", "stop", TESTSPACE_INSTANCE], env, { allowFailure: true });
        runCli(["stop"], env, { allowFailure: true });
        try {
            stopTestspaceWorkerProcesses(paths.runtime);
        } catch (cleanupError) {
            throw new AggregateError(
                [
                    error instanceof Error ? error : new Error(String(error)),
                    cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
                ],
                "Reverse Testspace startup failed and Worker cleanup was incomplete.",
            );
        }
        throw error;
    }
    const state = {
        controlPid,
        createdAt: new Date().toISOString(),
        intervalMs,
        mcpPort,
        namespaceToken: process.env[TESTSPACE_TOKEN_ENV],
        root,
        reverse,
        runtimeDirectory: paths.runtime,
        webPort,
    };
    await writeState(state);

    try {
        await ensureConnectorProcesses(connectorTargets(state), {
            isProcessAlive,
            readPid: readOptionalConnectorPid,
            rollbackConnector: async (target, pid) => await stopConnector(target, pid),
            startConnector: async (target) => await startConnector(target, env),
        });
    } catch (error) {
        runCli(["instance", "stop", TESTSPACE_INSTANCE], env, { allowFailure: true });
        runCli(["stop"], env, { allowFailure: true });
        try {
            stopTestspaceWorkerProcesses(paths.runtime);
        } catch (cleanupError) {
            throw new AggregateError(
                [
                    error instanceof Error ? error : new Error(String(error)),
                    cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
                ],
                "Testspace connector startup failed and Worker cleanup was incomplete.",
            );
        }
        throw error;
    }

    process.stdout.write("testspace started with local and reverse Workers, Control, MCP and Web.\n");
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

async function commentSmoke() {
    const state = await requireRunningState();
    const result = await runTestspaceCommentSmoke({
        endpoint: testspaceUrls(state).mcp,
        instance: TESTSPACE_INSTANCE,
        runtimeDirectory: stateRuntimeDirectory(state),
        workspace: paths.workspace,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function execInTestspace(argv) {
    const state = await requireRunningState();
    const command = argv[0] === "--" ? argv.slice(1) : argv;
    if (command.length === 0) usage("testspace exec requires a command");
    const env = testspaceEnvironment(stateRuntimeDirectory(state));
    assertTestspaceLifecycleEnvironment(root, env);
    const result = spawnSync(command[0], command.slice(1), {
        cwd: paths.workspace,
        env,
        stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
        throw new Error(`testspace exec exited with ${String(result.status)}`);
    }
}

async function status() {
    const state = await requireRunningState();
    const runtimeDirectory = stateRuntimeDirectory(state);
    const reverse = await readTestspaceReverseStatus({
        instanceName: TESTSPACE_REVERSE_INSTANCE,
        runtimeDirectory,
    });
    const connectors = await readConnectorStatuses(connectorTargets(state), {
        isProcessAlive,
        readHealth: readTestspaceConnectorHealth,
        readPid: readOptionalConnectorPid,
    });
    const instances = await withTestspaceControlConnection(
        runtimeDirectory,
        async (_shared, connection) => {
            const result = {};
            for (const instance of [TESTSPACE_INSTANCE, TESTSPACE_REVERSE_INSTANCE]) {
                const snapshot = await connection.request(instance, "runtime", "snapshot");
                result[instance] = snapshot.snapshot;
            }
            return result;
        },
    );
    process.stdout.write(`${JSON.stringify({
        connectors,
        controlPid: state.controlPid,
        instances,
        reverse,
        urls: testspaceUrls(state),
    }, null, 2)}\n`);
}

async function smoke() {
    const state = await requireRunningState();
    const runtimeDirectory = stateRuntimeDirectory(state);
    const reverse = await readTestspaceReverseStatus({
        instanceName: TESTSPACE_REVERSE_INSTANCE,
        runtimeDirectory,
    });
    if (!reverse.ready || !reverse.connected) {
        throw new Error(`reverse testspace instance is not connected: ${JSON.stringify(reverse)}`);
    }
    const terminals = await runTestspaceTerminalSmoke({
        runtimeDirectory,
        targets: [
            { instance: TESTSPACE_INSTANCE, workspace: paths.workspace },
            { instance: TESTSPACE_REVERSE_INSTANCE, workspace: paths.reverseWorkspace },
        ],
    });
    const comment = await runTestspaceCommentSmoke({
        endpoint: testspaceUrls(state).mcp,
        instance: TESTSPACE_INSTANCE,
        runtimeDirectory,
        workspace: paths.workspace,
    });
    const web = await runTestspaceWebSmoke({ webPort: state.webPort });
    process.stdout.write(`${JSON.stringify({ comment, reverse, terminals, web }, null, 2)}\n`);
}

async function stop() {
    const state = await readState();
    const runtimeDirectory = stateRuntimeDirectory(state);
    let controlPid = state?.controlPid;
    await stopConnectorProcesses(connectorProcessTargets());
    if (state === undefined) {
        const orphanControlPid = await readOptionalControlPid();
        controlPid = orphanControlPid;
        if (isProcessAlive(orphanControlPid)) {
            const env = testspaceEnvironment(runtimeDirectory);
            runCli(["instance", "stop", TESTSPACE_INSTANCE], env, { allowFailure: true, inherit: true });
            runCli(["stop"], env, { allowFailure: true, inherit: true });
        }
    } else {
        const env = testspaceEnvironment(runtimeDirectory);
        runCli(["instance", "stop", TESTSPACE_INSTANCE], env, { allowFailure: true, inherit: true });
        runCli(["stop"], env, { allowFailure: true, inherit: true });
    }
    stopTestspaceWorkerProcesses(runtimeDirectory);
    await waitForProcessExit(controlPid, 3_000);
    if (isProcessAlive(controlPid)) {
        throw new Error(`testspace control process ${String(controlPid)} is still running`);
    }
    await stopTestspaceTmux({
        devshellHome: join(paths.home, ".devshell"),
        instanceName: TESTSPACE_INSTANCE,
        runtimeDirectory,
        workspace: paths.workspace,
    });
    await stopTestspaceTmux({
        devshellHome: paths.reverseDevshellHome,
        instanceName: TESTSPACE_REVERSE_INSTANCE,
        runtimeDirectory: paths.reverseRuntime,
        workspace: paths.reverseWorkspace,
    });
    removeTestspaceDockerContainers(paths.instanceConfigDirectory);
    resetTestspacePodmanStorage(paths.home, runtimeDirectory);
    await removeOwnedTestspaceRoot(repoRoot, root);
    await Promise.all(runtimeDirectories(runtimeDirectory).map(async (directory) =>
        await rm(directory, { force: true, recursive: true })
    ));
    process.stdout.write("testspace stopped and removed.\n");
}

async function startConnector(target, env) {
    await Promise.all([
        rm(target.healthFile, { force: true }),
        rm(target.stopFile, { force: true }),
    ]);
    const logFd = openSync(target.processLog, "a");
    const connector = spawn(process.execPath, [
        fileURLToPath(import.meta.url),
        "connector-loop",
        target.instance,
    ], {
        cwd: repoRoot,
        detached: true,
        env,
        stdio: ["ignore", logFd, logFd],
    });
    connector.unref();
    closeSync(logFd);
    await writeFile(target.pidFile, `${connector.pid}\n`, "utf8");
    try {
        await waitForConnectorReady(target, connector.pid, {
            isProcessAlive,
            readHealth: async (candidate) =>
                await readTestspaceConnectorHealth(candidate.healthFile),
        });
        return connector.pid;
    } catch (error) {
        await stopConnector(target, connector.pid).catch(() => undefined);
        throw error;
    }
}

async function stopConnector(target, pid) {
    if (isProcessAlive(pid)) {
        await writeFile(target.stopFile, "stop\n", "utf8");
        process.kill(pid, "SIGTERM");
        const deadline = Date.now() + 3000;
        while (isProcessAlive(pid) && Date.now() < deadline) {
            await delay(25);
        }
        if (isProcessAlive(pid)) {
            throw new Error(`testspace connector process ${String(pid)} did not stop`);
        }
    }
    await rm(target.pidFile, { force: true });
}

async function stopConnectorProcesses(targets) {
    for (const target of targets) {
        await stopConnector(target, await readOptionalConnectorPid(target));
    }
}

async function connectorLoop(argv) {
    const state = await readState();
    if (state === undefined) throw new Error("missing testspace state");
    const instance = argv[0] ?? TESTSPACE_INSTANCE;
    const target = connectorTargets(state).find((candidate) => candidate.instance === instance);
    if (target === undefined) throw new Error(`unknown testspace connector instance: ${instance}`);
    await runConnectorLoop({
        endpoint: target.endpoint,
        healthFile: target.healthFile,
        instance: target.instance,
        intervalMs: state.intervalMs,
        logFile: target.logFile,
        seed: process.env.DEVSHELL_TESTSPACE_SEED,
        stopFile: target.stopFile,
        workspace: target.workspace,
    });
}

function runCli(cliArgs, env, options = {}) {
    assertTestspaceLifecycleEnvironment(root, env);
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
    return [...new Set([primary, paths.runtime, paths.reverseRuntime, paths.legacyRuntime])];
}

function connectorProcessTargets() {
    return [
        {
            healthFile: paths.connectorHealth,
            instance: TESTSPACE_INSTANCE,
            logFile: paths.connectorLog,
            pidFile: paths.connectorPid,
            processLog: paths.connectorProcessLog,
            stopFile: paths.stopFile,
        },
        {
            healthFile: paths.reverseConnectorHealth,
            instance: TESTSPACE_REVERSE_INSTANCE,
            logFile: paths.reverseConnectorLog,
            pidFile: paths.reverseConnectorPid,
            processLog: paths.reverseConnectorProcessLog,
            stopFile: paths.reverseConnectorStopFile,
        },
    ];
}

function connectorTargets(state) {
    const urls = testspaceUrls(state);
    return connectorProcessTargets().map((target) => ({
        ...target,
        endpoint: target.instance === TESTSPACE_INSTANCE ? urls.mcp : urls.reverseMcp,
        workspace: target.instance === TESTSPACE_INSTANCE ? paths.workspace : paths.reverseWorkspace,
    }));
}

async function readTestspaceInstanceSnapshot(runtimeDirectory, instance) {
    return await withTestspaceControlConnection(runtimeDirectory, async (_shared, connection) => {
        const response = await connection.request(instance, "runtime", "snapshot");
        return response.snapshot;
    });
}

function stopTestspaceWorkerProcesses(runtimeDirectory) {
    const environment = testspaceEnvironment(runtimeDirectory);
    return stopWorkerProcesses([
        {
            instance: TESTSPACE_INSTANCE,
            stop: () => stopTestspaceLocalWorker(environment),
        },
        {
            instance: TESTSPACE_REVERSE_INSTANCE,
            stop: () => stopTestspaceReverse({
                environment,
                paths,
                workerPath: workerPath(),
            }),
        },
    ]);
}

function stopTestspaceLocalWorker(environment) {
    assertTestspaceLifecycleEnvironment(root, environment);
    const result = spawnSync(workerPath(), ["stop", "--instance", TESTSPACE_INSTANCE], {
        encoding: "utf8",
        env: environment,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase();
    if (
        result.status !== 0 &&
        !output.includes("not running") &&
        !output.includes("not found") &&
        !output.includes("does not exist") &&
        !output.includes("no such file or directory")
    ) {
        throw new Error(
            result.stderr ||
            result.stdout ||
            result.error?.message ||
            `failed to stop local worker ${TESTSPACE_INSTANCE}`,
        );
    }
    return result.status === 0;
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

async function ensureWorkspace(directory, role) {
    const readme = [
        "# portable-devshell testspace",
        "",
        `This is the isolated ${role} worker workspace.`,
        "It may be modified by the testspace GPT-style connector simulator.",
        "All generated tool calls are limited to harmless reads, short shell output, Todo updates and short tmux tasks.",
        "",
    ].join("\n");
    await writeFile(join(directory, "README.md"), readme, "utf8");
    await writeFile(join(directory, "activity.txt"), `${role} testspace activity\n`, "utf8");
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

async function readOptionalConnectorPid(target) {
    try {
        return Number.parseInt((await readFile(target.pidFile, "utf8")).trim(), 10);
    } catch {
        return undefined;
    }
}

async function writeState(state) {
    await writeFile(paths.state, `${JSON.stringify({
        ...state,
        namespaceToken: process.env[TESTSPACE_TOKEN_ENV],
    }, null, 2)}\n`, "utf8");
}

async function readState() {
    try {
        const state = JSON.parse(await readFile(paths.state, "utf8"));
        return state?.namespaceToken === process.env[TESTSPACE_TOKEN_ENV] ? state : undefined;
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
        "Smoke Comment: pnpm testspace comment-smoke",
        "Status:       pnpm testspace status",
        "Protocol probes: pnpm testspace smoke",
        "Stop/remove:   pnpm testspace stop",
        "",
    ].join("\n"));
}

function printUrls(state) {
    const urls = testspaceUrls(state);
    process.stdout.write(
        `MCP local:   ${urls.mcp}\nMCP reverse: ${urls.reverseMcp}\nWeb:         ${urls.web}\n`,
    );
}

function usage(message) {
    process.stderr.write(`${message}\n`);
    process.stderr.write("Usage: pnpm testspace [start|comment-smoke|exec|status|smoke|tui|web|web-smoke|stop] [options]\n");
    process.exit(2);
}
