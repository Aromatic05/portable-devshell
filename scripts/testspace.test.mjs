import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
    resolveTestspaceCommand,
    resolveTestspaceInvocation,
    TESTSPACE_INSTANCE,
    TESTSPACE_REVERSE_INSTANCE,
    testspaceUrls,
} from "./testspace/TestspaceConfig.mjs";
import {
    createTestspaceProcessEnvironment,
    markTestspaceRootOwned,
    removeTestspaceDockerContainers,
    removeOwnedTestspaceRoot,
    resetTestspacePodmanStorage,
    resolveTestspaceRoot,
    resolveTestspaceRuntimeDirectory,
    resolveTestspaceTmuxSockets,
    stopTestspaceTmux,
} from "./testspace/TestspaceRuntime.mjs";
import {
    ensureConnectorProcesses,
    ensureInstanceReady,
    readConnectorStatuses,
    stopWorkerProcesses,
    waitForConnectorReady,
} from "./testspace/TestspaceLifecycle.mjs";
import {
    readTestspaceConnectorHealth,
    runConnectorLoop,
} from "./testspace/TestspaceConnector.mjs";
import {
    assertWebSmokeState,
    chromiumLaunchArguments,
    resolveChromiumExecutable,
} from "./testspace/TestspaceWebSmoke.mjs";

test("testspace URLs point at the isolated instance and Web UI", () => {
    assert.deepEqual(testspaceUrls({ mcpPort: 19000, webPort: 19001 }), {
        mcp: `http://127.0.0.1:19000/${TESTSPACE_INSTANCE}/mcp`,
        reverseMcp: `http://127.0.0.1:19000/${TESTSPACE_REVERSE_INSTANCE}/mcp`,
        web: "http://127.0.0.1:19001/web/",
    });
});

test("Web smoke disables the Chromium sandbox only for Linux CI", () => {
    assert.equal(
        chromiumLaunchArguments({ environment: { CI: "true" }, platform: "linux" })
            .includes("--no-sandbox"),
        true,
    );
    assert.equal(
        chromiumLaunchArguments({ environment: {}, platform: "linux" })
            .includes("--no-sandbox"),
        false,
    );
    assert.equal(
        chromiumLaunchArguments({ environment: { CI: "true" }, platform: "darwin" })
            .includes("--no-sandbox"),
        false,
    );
});

test("Web smoke requires the current Audit navigation contract", () => {
    const pageState = {
        alerts: [],
        body: `portable-devshell\nOverview\nAudit\n${TESTSPACE_INSTANCE}\nOnline`,
        randomUuidType: "undefined",
        secureContext: false,
    };

    assert.doesNotThrow(() => assertWebSmokeState(pageState, [], TESTSPACE_INSTANCE));
    assert.throws(
        () => assertWebSmokeState(
            { ...pageState, body: pageState.body.replace("Audit", "Tool Calls") },
            [],
            TESTSPACE_INSTANCE,
        ),
        /did not render the real testspace read model/u,
    );
});

test("testspace starts when invoked without a subcommand", () => {
    assert.equal(resolveTestspaceCommand(undefined), "start");
    assert.equal(resolveTestspaceCommand("start"), "start");
    assert.equal(resolveTestspaceCommand("--skip-build"), "start");
    assert.equal(resolveTestspaceCommand("tui"), "tui");
    assert.equal(resolveTestspaceCommand("web"), "web");
    assert.equal(resolveTestspaceCommand("web-smoke"), "web-smoke");
    assert.equal(resolveTestspaceCommand("comment-smoke"), "comment-smoke");
    assert.equal(resolveTestspaceCommand("smoke"), "smoke");
    assert.equal(resolveTestspaceCommand("status"), "status");
    assert.equal(resolveTestspaceCommand("stop"), "stop");
    assert.equal(resolveTestspaceCommand("logs"), "invalid");
    assert.equal(resolveTestspaceCommand("reset"), "invalid");
    assert.deepEqual(resolveTestspaceInvocation([]), { args: [], command: "start" });
    assert.deepEqual(resolveTestspaceInvocation(["web-smoke"]), {
        args: [],
        command: "web-smoke",
    });
    assert.deepEqual(resolveTestspaceInvocation(["start", "--skip-build"]), {
        args: ["--skip-build"],
        command: "start",
    });
    assert.deepEqual(resolveTestspaceInvocation(["--skip-build", "--interval-ms", "500"]), {
        args: ["--skip-build", "--interval-ms", "500"],
        command: "start",
    });
});

test("re-entering a running testspace restores a stopped local instance", async () => {
    const starts = [];
    const result = await ensureInstanceReady({
        instance: TESTSPACE_INSTANCE,
        readSnapshot: async () => ({
            name: TESTSPACE_INSTANCE,
            ready: false,
            status: "stopped",
        }),
        startInstance: async (instance) => {
            starts.push(instance);
            return { name: instance, ready: true, status: "ready" };
        },
    });

    assert.equal(result.restarted, true);
    assert.deepEqual(starts, [TESTSPACE_INSTANCE]);
    assert.equal(result.snapshot.ready, true);
});

test("re-entering a healthy testspace does not restart the local instance", async () => {
    let starts = 0;
    const result = await ensureInstanceReady({
        instance: TESTSPACE_INSTANCE,
        readSnapshot: async () => ({
            name: TESTSPACE_INSTANCE,
            ready: true,
            status: "ready",
        }),
        startInstance: async () => {
            starts += 1;
            throw new Error("healthy instance must not be restarted");
        },
    });

    assert.equal(result.restarted, false);
    assert.equal(starts, 0);
});

test("testspace keeps an activity connector alive for both local and reverse instances", async () => {
    const started = [];
    const targets = [
        { instance: TESTSPACE_INSTANCE },
        { instance: TESTSPACE_REVERSE_INSTANCE },
    ];
    const result = await ensureConnectorProcesses(targets, {
        isProcessAlive: (pid) => pid === 101,
        readPid: async (target) => target.instance === TESTSPACE_INSTANCE ? 101 : undefined,
        startConnector: async (target) => {
            started.push(target.instance);
            return 202;
        },
    });

    assert.deepEqual(started, [TESTSPACE_REVERSE_INSTANCE]);
    assert.deepEqual(result, {
        [TESTSPACE_INSTANCE]: { pid: 101, restarted: false },
        [TESTSPACE_REVERSE_INSTANCE]: { pid: 202, restarted: true },
    });
});

test("fresh connector startup rolls back connectors started before a later failure", async () => {
    const rolledBack = [];
    await assert.rejects(
        ensureConnectorProcesses(
            [
                { instance: TESTSPACE_INSTANCE },
                { instance: TESTSPACE_REVERSE_INSTANCE },
            ],
            {
                isProcessAlive: () => false,
                readPid: async () => undefined,
                rollbackConnector: async (target, pid) => {
                    rolledBack.push({ instance: target.instance, pid });
                },
                startConnector: async (target) => {
                    if (target.instance === TESTSPACE_INSTANCE) return 201;
                    throw new Error("reverse connector failed");
                },
            },
        ),
        /reverse connector failed/u,
    );
    assert.deepEqual(rolledBack, [{ instance: TESTSPACE_INSTANCE, pid: 201 }]);
});

test("re-entering testspace restarts an alive connector whose health is degraded", async () => {
    const restarted = [];
    const targets = [
        { healthFile: "/health/local", instance: TESTSPACE_INSTANCE },
        { healthFile: "/health/reverse", instance: TESTSPACE_REVERSE_INSTANCE },
    ];
    const result = await ensureConnectorProcesses(targets, {
        isProcessAlive: () => true,
        readHealth: async (target) => ({
            status: target.instance === TESTSPACE_INSTANCE ? "active" : "degraded",
        }),
        readPid: async (target) => target.instance === TESTSPACE_INSTANCE ? 101 : 102,
        restartConnector: async (target, pid) => {
            restarted.push({ instance: target.instance, pid });
            return 202;
        },
        startConnector: async () => {
            throw new Error("alive connectors must use restartConnector");
        },
    });

    assert.deepEqual(restarted, [{ instance: TESTSPACE_REVERSE_INSTANCE, pid: 102 }]);
    assert.deepEqual(result, {
        [TESTSPACE_INSTANCE]: { pid: 101, restarted: false },
        [TESTSPACE_REVERSE_INSTANCE]: { pid: 202, restarted: true },
    });
});

test("connector startup completes only after health reaches a usable state", async () => {
    const health = [
        { status: "starting" },
        { status: "connected" },
        { status: "active" },
    ];
    const ready = await waitForConnectorReady(
        { healthFile: "/health/local", instance: TESTSPACE_INSTANCE },
        101,
        {
            delay: async () => undefined,
            isProcessAlive: () => true,
            readHealth: async () => health.shift(),
            timeoutMs: 100,
        },
    );
    assert.equal(ready.status, "active");

    await assert.rejects(
        waitForConnectorReady(
            { healthFile: "/health/reverse", instance: TESTSPACE_REVERSE_INSTANCE },
            102,
            {
                delay: async () => undefined,
                isProcessAlive: () => true,
                readHealth: async () => ({ status: "error", lastError: "cannot connect" }),
                timeoutMs: 100,
            },
        ),
        /cannot connect/u,
    );
});

test("connector activity publishes health that status can expose", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pds-testspace-connector-health-"));
    t.after(async () => await rm(directory, { recursive: true, force: true }));
    const healthFile = join(directory, "health.json");
    const logFile = join(directory, "activity.jsonl");
    const stopFile = join(directory, "stop");
    const client = {
        async callTool() {
            return { isError: false, structuredContent: { ok: true } };
        },
        async close() {},
    };

    await runConnectorLoop({
        connectClient: async () => ({
            client,
            ctxId: "ctx-testspace-health",
            toolNames: new Set(["bash_run"]),
        }),
        endpoint: "http://127.0.0.1:19000/testspace-reverse/mcp",
        healthFile,
        instance: TESTSPACE_REVERSE_INSTANCE,
        intervalMs: 1,
        logFile,
        maxIterations: 1,
        seed: 1,
        stopFile,
    });

    const health = await readTestspaceConnectorHealth(healthFile);
    assert.equal(health?.instance, TESTSPACE_REVERSE_INSTANCE);
    assert.equal(health?.status, "active");
    assert.equal(typeof health?.lastActivityAt, "string");

    const statuses = await readConnectorStatuses(
        [{ healthFile, instance: TESTSPACE_REVERSE_INSTANCE, pidFile: join(directory, "pid") }],
        {
            isProcessAlive: () => true,
            readHealth: readTestspaceConnectorHealth,
            readPid: async () => 321,
        },
    );
    assert.equal(statuses[TESTSPACE_REVERSE_INSTANCE].running, true);
    assert.equal(statuses[TESTSPACE_REVERSE_INSTANCE].health?.status, "active");
});

test("a connector tool error is exposed as degraded rather than active", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pds-testspace-connector-degraded-"));
    t.after(async () => await rm(directory, { recursive: true, force: true }));
    const healthFile = join(directory, "health.json");
    await runConnectorLoop({
        connectClient: async () => ({
            client: {
                async callTool() {
                    return { isError: true, structuredContent: { ok: false } };
                },
                async close() {},
            },
            ctxId: "ctx-testspace-degraded",
            toolNames: new Set(["bash_run"]),
        }),
        endpoint: "http://127.0.0.1:19000/testspace-local/mcp",
        healthFile,
        instance: TESTSPACE_INSTANCE,
        intervalMs: 1,
        logFile: join(directory, "activity.jsonl"),
        maxIterations: 1,
        seed: 1,
        stopFile: join(directory, "stop"),
    });

    const health = await readTestspaceConnectorHealth(healthFile);
    assert.equal(health?.status, "degraded");
    assert.equal(health?.lastToolError, true);
});

test("worker cleanup attempts local and reverse even when one stop fails", () => {
    const calls = [];
    assert.throws(
        () => stopWorkerProcesses([
            {
                instance: TESTSPACE_INSTANCE,
                stop() {
                    calls.push(TESTSPACE_INSTANCE);
                    throw new Error("local stop failed");
                },
            },
            {
                instance: TESTSPACE_REVERSE_INSTANCE,
                stop() {
                    calls.push(TESTSPACE_REVERSE_INSTANCE);
                    return true;
                },
            },
        ]),
        AggregateError,
    );
    assert.deepEqual(calls, [TESTSPACE_INSTANCE, TESTSPACE_REVERSE_INSTANCE]);
});

test("testspace root rejects destructive cleanup targets that contain the repository", () => {
    const repo = join(tmpdir(), "portable-devshell-review-fixture");
    assert.throws(
        () => resolveTestspaceRoot(repo, ""),
        /must not be empty/u,
    );
    assert.throws(
        () => resolveTestspaceRoot(repo, repo),
        /must not contain the portable-devshell repository/u,
    );
    assert.throws(
        () => resolveTestspaceRoot(repo, dirname(repo)),
        /must not contain the portable-devshell repository/u,
    );
    assert.equal(
        resolveTestspaceRoot(repo, join(repo, ".interactive-testspace")),
        join(repo, ".interactive-testspace"),
    );
});

test("recursive Testspace cleanup refuses an existing directory until Testspace owns it", async (t) => {
    const repo = await mkdtemp(join(tmpdir(), "pds-testspace-owner-repo-"));
    const customRoot = join(repo, "packages");
    const sentinel = join(customRoot, "keep.txt");
    await mkdir(customRoot, { recursive: true });
    await writeFile(sentinel, "keep\n", "utf8");
    t.after(async () => await rm(repo, { force: true, recursive: true }));

    await assert.rejects(
        removeOwnedTestspaceRoot(repo, customRoot),
        /not owned by portable-devshell Testspace/u,
    );
    await access(sentinel);

    await markTestspaceRootOwned(repo, customRoot);
    await removeOwnedTestspaceRoot(repo, customRoot);
    await assert.rejects(access(customRoot), { code: "ENOENT" });
});

test("testspace runtime is deterministic and keeps Unix worker sockets short", () => {
    const options = {
        platform: "darwin",
        temporaryDirectory: "/var/folders/very/long/per-user/temporary/directory"
    };
    const first = resolveTestspaceRuntimeDirectory("/workspace/portable-devshell", options);
    const repeated = resolveTestspaceRuntimeDirectory("/workspace/portable-devshell", options);
    const other = resolveTestspaceRuntimeDirectory("/workspace/portable-devshell-other", options);

    assert.equal(first, repeated);
    assert.notEqual(first, other);
    assert.match(first, /^\/tmp\/pds-testspace-[0-9a-f]{16}$/u);
    assert.equal(
        join(first, "devshell-worker", TESTSPACE_INSTANCE, "worker.sock").length < 100,
        true,
    );

    const windows = resolveTestspaceRuntimeDirectory("C:\\workspace\\portable-devshell", {
        platform: "win32",
        temporaryDirectory: "C:\\Users\\runner\\AppData\\Local\\Temp"
    });
    assert.match(windows, /^C:\\Users\\runner\\AppData\\Local\\Temp\\pds-testspace-[0-9a-f]{16}$/u);
});

test("testspace process environment isolates runtime and container storage", () => {
    const env = createTestspaceProcessEnvironment(
        "/tmp/testspace-home",
        "/tmp/testspace-runtime",
        {
            DEVSHELL_WORKER_INTERNAL_INSTANCE: "host-instance",
            DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: "workspace",
            DEVSHELL_WORKER_INTERNAL_WORKSPACE: "/host/workspace",
            PATH: "/usr/bin",
        },
    );
    assert.equal(env.HOME, "/tmp/testspace-home");
    assert.equal(env.USERPROFILE, "/tmp/testspace-home");
    assert.equal(env.XDG_RUNTIME_DIR, "/tmp/testspace-runtime");
    assert.equal(env.XDG_DATA_HOME, join("/tmp/testspace-home", ".local", "share"));
    assert.equal(env.XDG_CONFIG_HOME, join("/tmp/testspace-home", ".config"));
    assert.equal(env.XDG_CACHE_HOME, join("/tmp/testspace-home", ".cache"));
    assert.equal(env.PATH, "/usr/bin");
    assert.equal("DEVSHELL_WORKER_INTERNAL_INSTANCE" in env, false);
    assert.equal("DEVSHELL_WORKER_INTERNAL_SECURITY_MODE" in env, false);
    assert.equal("DEVSHELL_WORKER_INTERNAL_WORKSPACE" in env, false);
});

test("testspace Podman cleanup resets the isolated store before directory removal", () => {
    const calls = [];
    const reset = resetTestspacePodmanStorage(
        "/tmp/testspace-home",
        "/tmp/testspace-runtime",
        {
            platform: "linux",
            ensureRuntime(directory) {
                calls.push({ directory, type: "runtime" });
            },
            exists: () => true,
            spawn(command, args, options) {
                calls.push({ command, args, options });
                return { status: 0, stderr: "" };
            },
        },
    );
    assert.equal(reset, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
        directory: "/tmp/testspace-runtime",
        type: "runtime",
    });
    assert.equal(calls[1].command, "podman");
    assert.deepEqual(calls[1].args, ["system", "reset", "--force"]);
    assert.equal(calls[1].options.env.HOME, "/tmp/testspace-home");
    assert.equal(
        calls[1].options.env.XDG_DATA_HOME,
        join("/tmp/testspace-home", ".local", "share"),
    );
    assert.equal(
        calls[1].options.env.XDG_RUNTIME_DIR,
        "/tmp/testspace-runtime",
    );
});

test("testspace Podman cleanup is disabled on Windows", () => {
    assert.equal(
        resetTestspacePodmanStorage(
            "C:\\testspace-home",
            "C:\\testspace-runtime",
            { platform: "win32" },
        ),
        false,
    );
});

test("testspace Docker cleanup removes only managed containers declared by isolated configs", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pds-testspace-docker-cleanup-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await writeFile(join(root, "managed.toml"), [
        'version = 2',
        'name = "managed-docker"',
        'provider = "docker"',
        '',
        '[container]',
        'mode = "existingImage"',
        'image = "ubuntu:24.04"',
        'containerName = "managed-container"',
    ].join("\n"), "utf8");
    await writeFile(join(root, "default-name.toml"), [
        'version = 2',
        'name = "default-docker"',
        'provider = "docker"',
        '',
        '[container]',
        'mode = "preset"',
        'preset = "ubuntu"',
    ].join("\n"), "utf8");
    await writeFile(join(root, "adopted.toml"), [
        'version = 2',
        'name = "adopted-docker"',
        'provider = "docker"',
        '',
        '[container]',
        'mode = "existingStoppedContainer"',
        'containerName = "user-container"',
    ].join("\n"), "utf8");
    await writeFile(join(root, "podman.toml"), [
        'version = 2',
        'name = "managed-podman"',
        'provider = "podman"',
        '',
        '[container]',
        'mode = "existingImage"',
        'image = "ubuntu:24.04"',
        'containerName = "podman-container"',
    ].join("\n"), "utf8");
    const calls = [];
    const removed = removeTestspaceDockerContainers(root, {
        spawn(command, args) {
            calls.push({ command, args });
            return { status: 0, stderr: "", stdout: `${args.at(-1)}\n` };
        },
    });
    assert.deepEqual(removed, ["devshell-default-docker", "managed-container"]);
    assert.deepEqual(calls, [
        { command: "docker", args: ["rm", "--force", "devshell-default-docker"] },
        { command: "docker", args: ["rm", "--force", "managed-container"] },
    ]);
});

test("Web smoke resolves an explicit Chromium executable before default candidates", () => {
    const probes = [];
    assert.equal(
        resolveChromiumExecutable(
            { PORTABLE_DEVSHELL_CHROMIUM: "/opt/chromium" },
            "linux",
            (candidate) => {
                probes.push(candidate);
                return candidate === "/opt/chromium";
            },
        ),
        "/opt/chromium",
    );
    assert.deepEqual(probes, ["/opt/chromium"]);
});

test("testspace stop terminates legacy and workspace-scoped tmux servers", {
    skip: process.platform === "win32" || spawnSync("tmux", ["-V"]).status !== 0,
}, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pds-testspace-root-"));
    const runtime = resolveTestspaceRuntimeDirectory(root);
    const devshellHome = join(root, "home", ".devshell");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const options = {
        devshellHome,
        instanceName: TESTSPACE_INSTANCE,
        runtimeDirectory: runtime,
        workspace,
    };
    const sockets = await resolveTestspaceTmuxSockets(options);
    for (const socket of sockets) await mkdir(dirname(socket), { recursive: true });
    t.after(async () => {
        for (const socket of sockets) {
            spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
        }
        await rm(runtime, { force: true, recursive: true });
        await rm(root, { force: true, recursive: true });
    });

    for (const socket of sockets) {
        const started = spawnSync("tmux", [
            "-S",
            socket,
            "new-session",
            "-d",
            "-s",
            "devshell",
            "-c",
            workspace,
            "sleep 60",
        ], { encoding: "utf8" });
        assert.equal(started.status, 0, started.stderr);
    }
    assert.equal(await stopTestspaceTmux(options), true);
    for (const socket of sockets) {
        assert.notEqual(
            spawnSync("tmux", ["-S", socket, "has-session", "-t", "devshell"]).status,
            0,
        );
    }
});

test("testspace reverse lifecycle enrolls with a one-time code and stops by persistent identity", async (t) => {
    const calls = [];
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-reverse-testspace-"));
    t.after(async () => await rm(root, { recursive: true, force: true }));
    const paths = {
        reverseDevshellHome: join(root, "reverse-home", ".devshell"),
        reverseHome: join(root, "reverse-home"),
        reverseRuntime: join(root, "reverse-runtime"),
        reverseWorkspace: join(root, "reverse-workspace"),
    };
    const { startTestspaceReverse, stopTestspaceReverse } = await import(
        "./testspace/TestspaceReverse.mjs"
    );
    const started = await startTestspaceReverse({
        controllerUrl: "http://127.0.0.1:47011",
        createDeviceCode: async (input) => {
            calls.push(["code", input]);
            return { deviceCode: "device-code-once" };
        },
        environment: {
            DEVSHELL_WORKER_INTERNAL_INSTANCE: "host-instance",
            DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: "workspace",
            DEVSHELL_WORKER_INTERNAL_WORKSPACE: "/host/workspace",
            PATH: "/usr/bin",
        },
        paths,
        runWorker: (input) => {
            calls.push(["worker", input]);
            return { status: 0, stdout: "enrolled testspace-reverse\n" };
        },
        runtimeDirectory: join(root, "control-runtime"),
        waitReady: async (input) => calls.push(["ready", input]),
        workerPath: "/repo/target/debug/devshell-worker",
    });

    assert.equal(started.instanceName, "testspace-reverse");
    assert.deepEqual(calls[0], ["code", {
        instanceName: "testspace-reverse",
        runtimeDirectory: join(root, "control-runtime"),
    }]);
    assert.deepEqual(calls[1][1].args, [
        "enroll",
        "--controller",
        "http://127.0.0.1:47011",
        "--device-code",
        "device-code-once",
    ]);
    assert.equal(calls[1][1].environment.HOME, paths.reverseHome);
    assert.equal(calls[1][1].environment.PORTABLE_DEVSHELL_HOME, paths.reverseDevshellHome);
    assert.equal(calls[1][1].environment.XDG_RUNTIME_DIR, paths.reverseRuntime);
    assert.equal("DEVSHELL_WORKER_INTERNAL_INSTANCE" in calls[1][1].environment, false);
    assert.equal("DEVSHELL_WORKER_INTERNAL_SECURITY_MODE" in calls[1][1].environment, false);
    assert.equal("DEVSHELL_WORKER_INTERNAL_WORKSPACE" in calls[1][1].environment, false);
    assert.deepEqual(calls[2], ["ready", {
        instanceName: "testspace-reverse",
        runtimeDirectory: join(root, "control-runtime"),
    }]);

    const stopped = stopTestspaceReverse({
        environment: { PATH: "/usr/bin" },
        paths,
        runWorker: (input) => {
            calls.push(["stop", input]);
            return { status: 0, stdout: "stopped\n" };
        },
        workerPath: "/repo/target/debug/devshell-worker",
    });
    assert.equal(stopped, true);
    assert.deepEqual(calls.at(-1)[1].args, [
        "stop",
        "--instance",
        "testspace-reverse",
    ]);
});
