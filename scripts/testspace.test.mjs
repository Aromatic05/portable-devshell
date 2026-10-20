import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    buildTestspaceInstanceConfig,
    buildTestspaceReverseInstanceConfig,
    resolveTestspaceCommand,
    resolveTestspaceInvocation,
    resolveTestspaceLaunchPlan,
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
    assertTestspaceExecutionContext,
    assertTestspaceLifecycleEnvironment,
    buildTestspaceExecutionEnvironment,
    LINUX_TESTSPACE_ISOLATION,
    PROCESS_TESTSPACE_ISOLATION,
    resolveTestspaceNamespaceDirectory,
} from "./testspace/TestspaceNamespace.mjs";
import {
    ensureConnectorProcesses,
    ensureInstanceReady,
    readConnectorStatuses,
    stopWorkerProcesses,
    waitForConnectorReady,
} from "./testspace/TestspaceLifecycle.mjs";
import {
    createSafeAction,
    readTestspaceConnectorHealth,
    runConnectorLoop,
} from "./testspace/TestspaceConnector.mjs";
import {
    TESTSPACE_LONG_WAIT_REQUEST_TIMEOUT_MS,
    TESTSPACE_LONG_WAIT_TASK_DURATION_MS,
    TESTSPACE_LONG_WAIT_TOOL_TIMEOUT_MS,
} from "./testspace/TestspaceLongWaitSmoke.mjs";
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

test("testspace launcher prepares build artifacts before entering the isolated runtime", () => {
    assert.deepEqual(resolveTestspaceLaunchPlan(["start"]), {
        command: "start",
        prepare: true,
        runtimeArgv: ["start", "--skip-build"],
    });
    assert.deepEqual(resolveTestspaceLaunchPlan(["start", "--skip-build"]), {
        command: "start",
        prepare: false,
        runtimeArgv: ["start", "--skip-build"],
    });
    assert.deepEqual(resolveTestspaceLaunchPlan(["status"]), {
        command: "status",
        prepare: false,
        runtimeArgv: ["status"],
    });
    assert.deepEqual(resolveTestspaceLaunchPlan(["extension-smoke"]), {
        command: "extension-smoke",
        prepare: false,
        runtimeArgv: ["extension-smoke"],
    });
    assert.deepEqual(resolveTestspaceLaunchPlan(["upgrade-smoke", "--skip-build"]), {
        command: "upgrade-smoke",
        prepare: false,
        runtimeArgv: ["upgrade-smoke", "--skip-build"],
    });
});

test("testspace instance fixtures use v4 model ACL without retired MCP policy", () => {
    for (const config of [
        buildTestspaceInstanceConfig(),
        buildTestspaceReverseInstanceConfig(),
    ]) {
        assert.match(config, /^version = 4$/mu);
        assert.match(config, /^contextMode = "explicit"$/mu);
        assert.match(config, /^\[extensions\]$/mu);
        assert.match(
            config,
            /^model = \["artifact", "comment", "instance", "mcp", "recall", "secret", "skill"\]$/mu,
        );
        assert.doesNotMatch(config, /^\[mcp\.tools\]$/mu);
        assert.doesNotMatch(config, /^groups =/mu);
        assert.doesNotMatch(config, /^capabilities =/mu);
    }
});

test("Web smoke disables the Chromium sandbox for Linux CI or map-root Testspace", () => {
    assert.equal(
        chromiumLaunchArguments({
            environment: { CI: "true" },
            platform: "linux",
            uid: 1000,
        }).includes("--no-sandbox"),
        true,
    );
    assert.equal(
        chromiumLaunchArguments({
            environment: {
                DEVSHELL_TESTSPACE_ISOLATION: LINUX_TESTSPACE_ISOLATION,
            },
            platform: "linux",
            uid: 0,
        }).includes("--no-sandbox"),
        true,
    );
    assert.equal(
        chromiumLaunchArguments({
            environment: {},
            platform: "linux",
            uid: 1000,
        }).includes("--no-sandbox"),
        false,
    );
    assert.equal(
        chromiumLaunchArguments({
            environment: { CI: "true" },
            platform: "darwin",
            uid: 0,
        }).includes("--no-sandbox"),
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

    assert.doesNotThrow(() =>
        assertWebSmokeState(pageState, [], TESTSPACE_INSTANCE),
    );
    assert.throws(
        () =>
            assertWebSmokeState(
                {
                    ...pageState,
                    body: pageState.body.replace("Audit", "Tool Calls"),
                },
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
    assert.equal(resolveTestspaceCommand("long-smoke"), "long-smoke");
    assert.equal(resolveTestspaceCommand("tui"), "tui");
    assert.equal(resolveTestspaceCommand("web"), "web");
    assert.equal(resolveTestspaceCommand("web-smoke"), "web-smoke");
    assert.equal(resolveTestspaceCommand("update-smoke"), "update-smoke");
    assert.equal(resolveTestspaceCommand("upgrade-smoke"), "upgrade-smoke");
    assert.equal(resolveTestspaceCommand("workflow-smoke"), "workflow-smoke");
    assert.equal(resolveTestspaceCommand("approval-smoke"), "approval-smoke");
    assert.equal(resolveTestspaceCommand("comment-smoke"), "comment-smoke");
    assert.equal(resolveTestspaceCommand("extension-smoke"), "extension-smoke");
    assert.equal(resolveTestspaceCommand("mailing-smoke"), "mailing-smoke");
    assert.equal(resolveTestspaceCommand("mcpapp-smoke"), "mcpapp-smoke");
    assert.equal(resolveTestspaceCommand("smoke"), "smoke");
    assert.equal(resolveTestspaceCommand("status"), "status");
    assert.equal(resolveTestspaceCommand("stop"), "stop");
    assert.equal(resolveTestspaceCommand("logs"), "invalid");
    assert.equal(resolveTestspaceCommand("reset"), "invalid");
    assert.deepEqual(resolveTestspaceInvocation([]), {
        args: [],
        command: "start",
    });
    assert.deepEqual(resolveTestspaceInvocation(["web-smoke"]), {
        args: [],
        command: "web-smoke",
    });
    assert.deepEqual(resolveTestspaceInvocation(["start", "--skip-build"]), {
        args: ["--skip-build"],
        command: "start",
    });
    assert.deepEqual(
        resolveTestspaceInvocation(["--skip-build", "--interval-ms", "500"]),
        {
            args: ["--skip-build", "--interval-ms", "500"],
            command: "start",
        },
    );
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
        readPid: async (target) =>
            target.instance === TESTSPACE_INSTANCE ? 101 : undefined,
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
            status:
                target.instance === TESTSPACE_INSTANCE ? "active" : "degraded",
        }),
        readPid: async (target) =>
            target.instance === TESTSPACE_INSTANCE ? 101 : 102,
        restartConnector: async (target, pid) => {
            restarted.push({ instance: target.instance, pid });
            return 202;
        },
        startConnector: async () => {
            throw new Error("alive connectors must use restartConnector");
        },
    });

    assert.deepEqual(restarted, [
        { instance: TESTSPACE_REVERSE_INSTANCE, pid: 102 },
    ]);
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
            {
                healthFile: "/health/reverse",
                instance: TESTSPACE_REVERSE_INSTANCE,
            },
            102,
            {
                delay: async () => undefined,
                isProcessAlive: () => true,
                readHealth: async () => ({
                    status: "error",
                    lastError: "cannot connect",
                }),
                timeoutMs: 100,
            },
        ),
        /cannot connect/u,
    );
});

test("connector activity publishes health that status can expose", async (t) => {
    const directory = await mkdtemp(
        join(tmpdir(), "pds-testspace-connector-health-"),
    );
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
        [
            {
                healthFile,
                instance: TESTSPACE_REVERSE_INSTANCE,
                pidFile: join(directory, "pid"),
            },
        ],
        {
            isProcessAlive: () => true,
            readHealth: readTestspaceConnectorHealth,
            readPid: async () => 321,
        },
    );
    assert.equal(statuses[TESTSPACE_REVERSE_INSTANCE].running, true);
    assert.equal(statuses[TESTSPACE_REVERSE_INSTANCE].health?.status, "active");
});

test("testspace tmux activity uses the public tmux_run timeout contract", () => {
    assert.deepEqual(
        createSafeAction("tmux_run", { ctxId: "ctx-test", iteration: 7 }),
        {
            arguments: {
                command: "printf '\\033[32mtestspace tmux tick 7\\033[0m\\n'",
                ctxId: "ctx-test",
                timeout: 2000,
                wait: "block",
            },
            name: "tmux_run",
        },
    );
});

test("testspace long wait smoke outlives the 180 second synchronous boundary and SDK default timeout", () => {
    assert.equal(TESTSPACE_LONG_WAIT_TASK_DURATION_MS > 180_000, true);
    assert.equal(
        TESTSPACE_LONG_WAIT_TOOL_TIMEOUT_MS >
            TESTSPACE_LONG_WAIT_TASK_DURATION_MS,
        true,
    );
    assert.equal(
        TESTSPACE_LONG_WAIT_REQUEST_TIMEOUT_MS >
            TESTSPACE_LONG_WAIT_TOOL_TIMEOUT_MS,
        true,
    );
    assert.equal(TESTSPACE_LONG_WAIT_REQUEST_TIMEOUT_MS > 60_000, true);
});

test("a connector tool error is exposed as degraded rather than active", async (t) => {
    const directory = await mkdtemp(
        join(tmpdir(), "pds-testspace-connector-degraded-"),
    );
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
        () =>
            stopWorkerProcesses([
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
    assert.throws(() => resolveTestspaceRoot(repo, ""), /must not be empty/u);
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
        temporaryDirectory:
            "/var/folders/very/long/per-user/temporary/directory",
    };
    const first = resolveTestspaceRuntimeDirectory(
        "/workspace/portable-devshell",
        options,
    );
    const repeated = resolveTestspaceRuntimeDirectory(
        "/workspace/portable-devshell",
        options,
    );
    const other = resolveTestspaceRuntimeDirectory(
        "/workspace/portable-devshell-other",
        options,
    );

    assert.equal(first, repeated);
    assert.notEqual(first, other);
    assert.match(first, /^\/tmp\/pds-testspace-[0-9a-f]{16}$/u);
    assert.equal(
        join(first, "devshell-worker", TESTSPACE_INSTANCE, "worker.sock")
            .length < 100,
        true,
    );

    const windows = resolveTestspaceRuntimeDirectory(
        "C:\\workspace\\portable-devshell",
        {
            platform: "win32",
            temporaryDirectory: "C:\\Users\\runner\\AppData\\Local\\Temp",
        },
    );
    assert.match(
        windows,
        /^C:\\Users\\runner\\AppData\\Local\\Temp\\pds-testspace-[0-9a-f]{16}$/u,
    );
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
    assert.equal(
        env.XDG_DATA_HOME,
        join("/tmp/testspace-home", ".local", "share"),
    );
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
    await writeFile(
        join(root, "managed.toml"),
        [
            "version = 2",
            'name = "managed-docker"',
            'provider = "docker"',
            "",
            "[container]",
            'mode = "existingImage"',
            'image = "ubuntu:24.04"',
            'containerName = "managed-container"',
        ].join("\n"),
        "utf8",
    );
    await writeFile(
        join(root, "default-name.toml"),
        [
            "version = 2",
            'name = "default-docker"',
            'provider = "docker"',
            "",
            "[container]",
            'mode = "preset"',
            'preset = "ubuntu"',
        ].join("\n"),
        "utf8",
    );
    await writeFile(
        join(root, "adopted.toml"),
        [
            "version = 2",
            'name = "adopted-docker"',
            'provider = "docker"',
            "",
            "[container]",
            'mode = "existingStoppedContainer"',
            'containerName = "user-container"',
        ].join("\n"),
        "utf8",
    );
    await writeFile(
        join(root, "podman.toml"),
        [
            "version = 2",
            'name = "managed-podman"',
            'provider = "podman"',
            "",
            "[container]",
            'mode = "existingImage"',
            'image = "ubuntu:24.04"',
            'containerName = "podman-container"',
        ].join("\n"),
        "utf8",
    );
    const calls = [];
    const removed = removeTestspaceDockerContainers(root, {
        spawn(command, args) {
            calls.push({ command, args });
            return { status: 0, stderr: "", stdout: `${args.at(-1)}\n` };
        },
    });
    assert.deepEqual(removed, ["devshell-default-docker", "managed-container"]);
    assert.deepEqual(calls, [
        {
            command: "docker",
            args: ["rm", "--force", "devshell-default-docker"],
        },
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

test(
    "testspace stop terminates legacy and workspace-scoped tmux servers",
    {
        skip:
            process.platform === "win32" ||
            spawnSync("tmux", ["-V"]).status !== 0,
    },
    async (t) => {
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
        for (const socket of sockets)
            await mkdir(dirname(socket), { recursive: true });
        t.after(async () => {
            for (const socket of sockets) {
                spawnSync("tmux", ["-S", socket, "kill-server"], {
                    stdio: "ignore",
                });
            }
            await rm(runtime, { force: true, recursive: true });
            await rm(root, { force: true, recursive: true });
        });

        for (const socket of sockets) {
            const started = spawnSync(
                "tmux",
                [
                    "-S",
                    socket,
                    "new-session",
                    "-d",
                    "-s",
                    "devshell",
                    "-c",
                    workspace,
                    "sleep 60",
                ],
                { encoding: "utf8" },
            );
            assert.equal(started.status, 0, started.stderr);
        }
        assert.equal(await stopTestspaceTmux(options), true);
        for (const socket of sockets) {
            assert.notEqual(
                spawnSync("tmux", [
                    "-S",
                    socket,
                    "has-session",
                    "-t",
                    "devshell",
                ]).status,
                0,
            );
        }
    },
);

test("testspace reverse lifecycle enrolls with a one-time code and stops by persistent identity", async (t) => {
    const calls = [];
    const root = await mkdtemp(
        join(tmpdir(), "portable-devshell-reverse-testspace-"),
    );
    t.after(async () => await rm(root, { recursive: true, force: true }));
    const paths = {
        reverseDevshellHome: join(root, "reverse-home", ".devshell"),
        reverseHome: join(root, "reverse-home"),
        reverseRuntime: join(root, "reverse-runtime"),
        reverseWorkspace: join(root, "reverse-workspace"),
    };
    const { startTestspaceReverse, stopTestspaceReverse } =
        await import("./testspace/TestspaceReverse.mjs");
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
    assert.deepEqual(calls[0], [
        "code",
        {
            instanceName: "testspace-reverse",
            runtimeDirectory: join(root, "control-runtime"),
        },
    ]);
    assert.deepEqual(calls[1][1].args, [
        "enroll",
        "--controller",
        "http://127.0.0.1:47011",
        "--device-code",
        "device-code-once",
    ]);
    assert.equal(calls[1][1].environment.HOME, paths.reverseHome);
    assert.equal(
        calls[1][1].environment.PORTABLE_DEVSHELL_HOME,
        paths.reverseDevshellHome,
    );
    assert.equal(calls[1][1].environment.XDG_RUNTIME_DIR, paths.reverseRuntime);
    assert.equal(
        "DEVSHELL_WORKER_INTERNAL_INSTANCE" in calls[1][1].environment,
        false,
    );
    assert.equal(
        "DEVSHELL_WORKER_INTERNAL_SECURITY_MODE" in calls[1][1].environment,
        false,
    );
    assert.equal(
        "DEVSHELL_WORKER_INTERNAL_WORKSPACE" in calls[1][1].environment,
        false,
    );
    assert.deepEqual(calls[2], [
        "ready",
        {
            instanceName: "testspace-reverse",
            runtimeDirectory: join(root, "control-runtime"),
        },
    ]);

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

test("testspace exposes exec only through the guarded command surface", () => {
    assert.equal(resolveTestspaceCommand("exec"), "exec");
    assert.deepEqual(
        resolveTestspaceInvocation(["exec", "--", "printf", "ok"]),
        {
            args: ["--", "printf", "ok"],
            command: "exec",
        },
    );
});

test("testspace lifecycle rejects direct or host-home execution", () => {
    const root = "/tmp/testspace-guard";
    assert.throws(
        () => assertTestspaceExecutionContext(root, {}, { platform: "linux" }),
        /guarded Testspace launcher/u,
    );
    const guarded = buildTestspaceExecutionEnvironment(root, "a".repeat(48), {
        baseEnvironment: { PATH: "/usr/bin" },
        isolation: LINUX_TESTSPACE_ISOLATION,
        platform: "linux",
    });
    assert.doesNotThrow(() =>
        assertTestspaceLifecycleEnvironment(root, guarded, {
            platform: "linux",
        }),
    );
    assert.throws(
        () =>
            assertTestspaceLifecycleEnvironment(
                root,
                { ...guarded, HOME: "/home/real-user" },
                { platform: "linux" },
            ),
        /non-isolated HOME/u,
    );
    const portable = buildTestspaceExecutionEnvironment(root, "b".repeat(48), {
        isolation: PROCESS_TESTSPACE_ISOLATION,
        platform: "darwin",
        runtimeOptions: { platform: "darwin", temporaryDirectory: "/tmp" },
    });
    assert.doesNotThrow(() =>
        assertTestspaceExecutionContext(root, portable, { platform: "darwin" }),
    );
});

test("Testspace launcher preserves its runtime UID across user namespace process identity changes", () => {
    const root = "/tmp/testspace-stable-host-runtime-uid";
    // An inner --map-root-user process sees uid=0 instead of the outer uid.
    // Supply a deliberately distinct launcher identity to reproduce the
    // cross-namespace situation without requiring userns support in CI.
    const launcher = buildTestspaceExecutionEnvironment(root, "a".repeat(48), {
        baseEnvironment: { PATH: process.env.PATH ?? "/usr/bin" },
        isolation: LINUX_TESTSPACE_ISOLATION,
        platform: "linux",
        runtimeOptions: { userIdentity: "outer-uid-1000" },
    });
    assert.equal(launcher.DEVSHELL_TESTSPACE_RUNTIME_UID, "outer-uid-1000");
    const result = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `import { resolveTestspaceRuntimeDirectory } from ${JSON.stringify(new URL("./testspace/TestspaceRuntime.mjs", import.meta.url).href)};
         import { assertTestspaceLifecycleEnvironment } from ${JSON.stringify(new URL("./testspace/TestspaceNamespace.mjs", import.meta.url).href)};
         const root = process.argv[1];
         assertTestspaceLifecycleEnvironment(root, process.env);
         process.stdout.write(resolveTestspaceRuntimeDirectory(root));`,
        root,
    ], {
        encoding: "utf8",
        env: launcher,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, launcher.XDG_RUNTIME_DIR);
});

test("testspace namespace state path is deterministic per user and root", () => {
    const first = resolveTestspaceNamespaceDirectory("/workspace/one", {
        temporaryDirectory: "/tmp",
        userIdentity: "1000",
    });
    const repeated = resolveTestspaceNamespaceDirectory("/workspace/one", {
        temporaryDirectory: "/tmp",
        userIdentity: "1000",
    });
    const other = resolveTestspaceNamespaceDirectory("/workspace/two", {
        temporaryDirectory: "/tmp",
        userIdentity: "1000",
    });
    assert.equal(first, repeated);
    assert.notEqual(first, other);
    assert.match(first, /^\/tmp\/pds-testspace-ns-1000-[0-9a-f]{16}$/u);
});

test("recovery smoke parser and launch plan preserve the guarded runtime without rebuilding", () => {
    assert.equal(resolveTestspaceCommand("recovery-smoke"), "recovery-smoke");
    assert.deepEqual(resolveTestspaceInvocation(["recovery-smoke"]), {
        command: "recovery-smoke", args: [],
    });
    assert.deepEqual(resolveTestspaceLaunchPlan(["recovery-smoke"]), {
        command: "recovery-smoke", prepare: false, runtimeArgv: ["recovery-smoke"],
    });
    assert.equal(resolveTestspaceCommand("recovery-smoke-typo"), "invalid");
});

test("recovery smoke refuses unguarded invocation before opening IPC or HTTP", async () => {
    const { runTestspaceRecoverySmoke } = await import("./testspace/TestspaceRecoverySmoke.mjs");
    await assert.rejects(runTestspaceRecoverySmoke({
        endpoint: "http://127.0.0.1:1/never-contact", runtimeDirectory: "/never-open", workspace: "/never-write",
    }), /guarded Testspace launcher/u);
});

test("recovery stream assertion rejects gap, close, wrong origin and duplicate or skipped revisions", async () => {
    const { assertRecoveryEvent } = await import("./testspace/TestspaceRecoverySmoke.mjs");
    assertRecoveryEvent({ kind: "event", event: { kind: "config", revision: 42 } }, 42);
    for (const message of [
        { kind: "gap", gap: { fromSeq: 42, nextSeq: 43, lastSeq: 45 } },
        { kind: "closed" },
        { kind: "event", event: { kind: "registry", revision: 42 } },
        { kind: "event", event: { kind: "config", revision: 41 } },
        { kind: "event", event: { kind: "config", revision: 43 } },
    ]) assert.throws(() => assertRecoveryEvent(message, 42), { code: "ERR_ASSERTION" });
});

test("recovery audit comparison detects payload corruption, missing calls and duplicates independent of order", async () => {
    const { assertRecoveryAudit } = await import("./testspace/TestspaceRecoverySmoke.mjs");
    const before = [0, 7].map((exitCode) => ({
        callId: `call-${exitCode}`, ctxId: "ctx-recovery", status: "completed", exitCode,
        input: { command: `exit ${exitCode}` }, output: { stdout: `out-${exitCode}`, stderr: "err", exitCode },
    }));
    assertRecoveryAudit(before, [...structuredClone(before)].reverse());
    assert.throws(() => assertRecoveryAudit(before, before.slice(0, 1)), { code: "ERR_ASSERTION" });
    assert.throws(() => assertRecoveryAudit(before, [before[0], before[0]]), { code: "ERR_ASSERTION" });
    const corrupted = structuredClone(before);
    corrupted[1].output.stderr = "lost-stderr";
    assert.throws(() => assertRecoveryAudit(before, corrupted), { code: "ERR_ASSERTION" });
    const reassigned = structuredClone(before);
    reassigned[1].ctxId = "other-context";
    assert.throws(() => assertRecoveryAudit(before, reassigned), { code: "ERR_ASSERTION" });
});

test("recovery deadline propagates errors and bounds a stalled stream without cancelling product work", async () => {
    const { recoveryDeadline } = await import("./testspace/TestspaceRecoverySmoke.mjs");
    assert.equal(await recoveryDeadline(Promise.resolve("settled"), "completed read", 100), "settled");
    const failure = new Error("original transport fault");
    await assert.rejects(recoveryDeadline(Promise.reject(failure), "fault", 100), (error) => error === failure);
    await assert.rejects(recoveryDeadline(new Promise(() => {}), "pending IPC read", 1), /timed out: pending IPC read/u);
});

// Real storage checks remain runnable when the workspace disallows listen().
// Load current source, so this does not silently verify a stale dist build.
async function recoveryAuditDatabase() {
    const { tsImport } = await import("tsx/esm/api");
    return (await tsImport("../packages/core/src/audit/database/index.ts", {
        parentURL: import.meta.url, tsconfig: fileURLToPath(new URL("../tsconfig.test.json", import.meta.url)),
    })).AuditDatabase;
}

function recoveryAuditRecords() {
    return [0, 7].map((exitCode) => ({
        callId: `recovery-call-${exitCode}`, ctxId: "recovery-context", instance: "recovery-local",
        source: "mcp", toolName: "bash_run", status: "completed", exitCode,
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        inputSummary: `exit ${exitCode}`, workspace: "/isolated/workspace",
        input: { command: `printf '持久化'; exit ${exitCode}` },
        output: { stdout: "持久化\n", stderr: "stderr survives\u0000too", exitCode },
    }));
}

test("recovery real SQLite audit survives repeated close/reopen with exact call payloads and IDs", async (t) => {
    const { assertRecoveryAudit } = await import("./testspace/TestspaceRecoverySmoke.mjs");
    const AuditDatabase = await recoveryAuditDatabase();
    const root = await mkdtemp(join(tmpdir(), "pds-recovery-audit-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "audit.sqlite");
    const options = { maxBytes: 16 * 1024 * 1024, retentionDays: 7 };
    const records = recoveryAuditRecords();
    const storeOptions = { timestamp: (record) => record.startedAt };
    let database = new AuditDatabase(file, options);
    t.after(() => database.close());
    const store = database.toolCallStore(storeOptions);
    for (const record of records) await store.append(record);
    const query = { ctxId: "recovery-context", toolName: "bash_run", includeInput: true, includeOutput: true };
    assertRecoveryAudit(records, store.readQuery(query));
    await database.close();
    for (let generation = 0; generation < 3; generation += 1) {
        database = new AuditDatabase(file, options);
        const recovered = database.toolCallStore(storeOptions);
        assertRecoveryAudit(records, recovered.readQuery(query));
        assert.equal(recovered.hasCall(records[0].callId), true);
        assert.equal(recovered.hasCall(records[1].callId), true);
        assert.deepEqual(recovered.readQuery({ ...query, ctxId: "unrelated-context" }), []);
        await database.close();
    }
});

test("recovery real SQLite close drains queued audit writes before another lifetime reads them", async (t) => {
    const { assertRecoveryAudit } = await import("./testspace/TestspaceRecoverySmoke.mjs");
    const AuditDatabase = await recoveryAuditDatabase();
    const root = await mkdtemp(join(tmpdir(), "pds-recovery-drain-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "audit.sqlite");
    const options = { maxBytes: 16 * 1024 * 1024, retentionDays: 7 };
    const storeOptions = { timestamp: (record) => record.startedAt };
    const database = new AuditDatabase(file, options);
    t.after(() => database.close());
    const store = database.toolCallStore(storeOptions);
    const records = recoveryAuditRecords();
    const writes = records.map((record) => store.append(record));
    // Closing immediately is the actual shutdown interleaving; no sleep or
    // mocked flush acknowledgement can hide loss of a queued write.
    await database.close();
    await Promise.all(writes);
    const reopened = new AuditDatabase(file, options);
    t.after(() => reopened.close());
    assertRecoveryAudit(records, reopened.toolCallStore(storeOptions).readQuery({ ctxId: "recovery-context" }));
    await reopened.close();
});

test("recovery real instance history defines an exact 256 revision gap boundary and resume cursor", async () => {
    const { InstanceChangeHub } = await import("../packages/control/src/instance/Change.ts");
    const hub = new InstanceChangeHub();
    for (let revision = 1; revision <= 256; revision += 1) hub.publish("config");
    assert.equal(hub.replay(1).kind, "replay");
    assert.equal(hub.replay(1).changes.length, 256);
    hub.publish("config");
    assert.deepEqual(hub.replay(1), { kind: "gap", gap: {
        lastRevision: 257, oldestAvailableRevision: 2, requestedFromRevision: 1,
    } });
    assert.deepEqual(hub.replay(257), { kind: "replay", lastRevision: 257,
        changes: [{ kind: "config", revision: 257 }] });
    assert.deepEqual(hub.replay(258), { kind: "replay", lastRevision: 257, changes: [] });
    hub.publish("config");
    assert.deepEqual(hub.replay(258).changes, [{ kind: "config", revision: 258 }]);
});

test("recovery runtime dispatch requires running owned state and exposes the manual command", async () => {
    const { readFile } = await import("node:fs/promises");
    const runtime = await readFile(new URL("./testspace.mjs", import.meta.url), "utf8");
    const launcher = await readFile(new URL("./testspace-launcher.mjs", import.meta.url), "utf8");
    assert.match(runtime, /import \{ runTestspaceRecoverySmoke \} from "\.\/testspace\/TestspaceRecoverySmoke\.mjs"/u);
    assert.match(runtime, /case "recovery-smoke":\s+await recoverySmoke\(\);\s+break;/u);
    assert.match(runtime, /async function recoverySmoke\(\) \{\s+const state = await requireRunningState\(\);\s+const result = await runTestspaceRecoverySmoke\(\{\s+endpoint: testspaceUrls\(state\)\.mcp,\s+runtimeDirectory: stateRuntimeDirectory\(state\),\s+workspace: paths\.workspace,/u);
    assert.match(runtime, /Recovery:.*pnpm testspace recovery-smoke/u);
    assert.match(runtime, /Usage: pnpm testspace \[start\|recovery-smoke\|/u);
    assert.match(launcher, /ensureLinuxTestspaceNamespace\(root,/u);
    assert.match(launcher, /runInsideTestspaceNamespace\(\s+namespace,\s+scriptPath,\s+runtimeArgv,/u);
});

test("recovery real Todo and SQLite event storage retain revision fencing across service lifetimes", async (t) => {
    const { tsImport } = await import("tsx/esm/api");
    const { TodoService } = await tsImport("../packages/core/src/task/todo/index.ts", {
        parentURL: import.meta.url, tsconfig: fileURLToPath(new URL("../tsconfig.test.json", import.meta.url)),
    });
    const AuditDatabase = await recoveryAuditDatabase();
    const root = await mkdtemp(join(tmpdir(), "pds-recovery-todo-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { readFile } = await import("node:fs/promises");
    const filePath = join(root, "todo.json");
    const auditPath = join(root, "audit.sqlite");
    const databaseOptions = { maxBytes: 16 * 1024 * 1024, retentionDays: 7 };
    const eventOptions = { sequence: (event) => event.seq, timestamp: (event) => event.at };
    let database = new AuditDatabase(auditPath, databaseOptions);
    t.after(() => database.close());
    let events = database.store("events", eventOptions);
    let sequence = events.readHighWater();
    const createService = () => new TodoService({
        filePath, instanceName: "recovery-local",
        appendEvent: (type, data) => events.append({
            type, data, seq: ++sequence, at: new Date().toISOString(), instanceName: "recovery-local",
        }),
    });
    const first = createService();
    const created = await first.write({ revision: 0, title: "recover committed work",
        todos: [{ id: "verify", content: "verify restart", status: "in_progress" }] }, "recovery-context");
    assert.equal(created.revision, 1);
    const committedFile = await readFile(filePath, "utf8");
    const committedEvents = events.readAll();
    assert.equal(committedEvents[0].type, "todo.created");
    await database.close();
    database = new AuditDatabase(auditPath, databaseOptions);
    events = database.store("events", eventOptions);
    sequence = events.readHighWater();
    const recovered = createService();
    assert.deepEqual(await recovered.read({ taskId: created.taskId }), created);
    assert.deepEqual(events.readAll(), committedEvents);
    await assert.rejects(recovered.write({ taskId: created.taskId, revision: 0,
        title: created.title, todos: [{ id: "verify", content: "lost update", status: "pending" }] },
    "recovery-context"), { code: "todo.revisionConflict" });
    assert.equal(await readFile(filePath, "utf8"), committedFile);
    assert.deepEqual(events.readAll(), committedEvents);
    const updated = await recovered.write({ taskId: created.taskId, revision: created.revision,
        title: created.title, todos: [{ id: "verify", content: "verify restart", status: "completed" }] },
    "recovery-context");
    assert.equal(updated.revision, 2);
    assert.equal(updated.summary.completed, 1);
    assert.ok(events.readHighWater() > committedEvents.at(-1).seq);
    await database.close();
    database = new AuditDatabase(auditPath, databaseOptions);
    events = database.store("events", eventOptions);
    assert.deepEqual(await createService().read({ taskId: created.taskId }), updated);
    assert.equal(events.readAll().filter((event) => event.type === "todo.completed").length, 1);
    await database.close();
});

test("recovery real audit runtime drains logs on shutdown and reopens compressed output with call isolation", async (t) => {
    const { tsImport } = await import("tsx/esm/api");
    const { createAuditRuntime } = await tsImport("../packages/core/src/audit/index.ts", {
        parentURL: import.meta.url, tsconfig: fileURLToPath(new URL("../tsconfig.test.json", import.meta.url)),
    });
    const root = await mkdtemp(join(tmpdir(), "pds-recovery-runtime-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const options = { instanceName: "recovery-local", filePath: join(root, "audit.sqlite"),
        eventBufferSize: 500, limits: { maxBytes: 16 * 1024 * 1024, retentionDays: 7 } };
    let runtime = createAuditRuntime(options);
    t.after(() => runtime.close());
    const stdout = "持久化🌍\u0000".repeat(2048);
    const stderr = "independent stderr\n".repeat(1024);
    const context = { callId: "recovery-call", ctxId: "recovery-context", source: "mcp", toolName: "bash_run" };
    const at = new Date().toISOString();
    const stdoutWrite = runtime.api.logs.append("stdout", stdout, at, context);
    const stderrWrite = runtime.api.logs.append("stderr", stderr, at, context);
    // Production composition owns the log queue as well as SQLite's queue.
    // Closing the runtime must drain both in the correct order.
    await runtime.close();
    const committed = await Promise.all([stdoutWrite, stderrWrite]);
    assert.deepEqual(committed.map((entry) => entry.seq), [1, 2]);
    runtime = createAuditRuntime(options);
    assert.deepEqual(await runtime.api.logs.read({ callId: context.callId, ctxId: context.ctxId }), committed);
    assert.deepEqual(await runtime.api.logs.read({ callId: context.callId, ctxId: "other-context" }), []);
    assert.deepEqual(await runtime.api.logs.read({ callId: "other-call", ctxId: context.ctxId }), []);
    const next = await runtime.api.logs.append("stdout", "after recovery", at, context);
    assert.equal(next.seq, 3, "Log sequence high water must survive the runtime lifetime");
    await runtime.close();
    runtime = createAuditRuntime(options);
    assert.deepEqual(await runtime.api.logs.read({ callId: context.callId, ctxId: context.ctxId }), [...committed, next]);
    await runtime.close();
});

test("retirement-smoke remains manual and never prepares builds or runs for implicit default start", () => {
    assert.deepEqual(resolveTestspaceInvocation(["retirement-smoke"]), {
        command: "retirement-smoke", args: [],
    });
    assert.deepEqual(resolveTestspaceLaunchPlan(["retirement-smoke"]), {
        command: "retirement-smoke", prepare: false, runtimeArgv: ["retirement-smoke"],
    });
    assert.equal(resolveTestspaceCommand("retirement-smoke"), "retirement-smoke");
    assert.equal(resolveTestspaceCommand(undefined), "start");
});

test("retirement-smoke rejects unresolved local Worker cleanup even after config was deleted", async () => {
    const { assertRetiredInstance } = await import("./testspace/TestspaceRetirementSmoke.mjs");
    assert.throws(() => assertRetiredInstance({
        name: "local-worker",
        result: {
            appliedChanges: [{ kind: "instance.deleted", target: "local-worker" }],
            cleanupPending: true,
            cleanupWarnings: ["Worker runtime retirement failed"],
        },
        debts: [{ instance: "local-worker", state: "pending", generationId: "old-generation" }],
    }), /Worker runtime retirement failed/u);
});

test("retirement-smoke verifies old-Generation debt instead of hiding it behind a successful delete reply", async () => {
    const { assertRetiredInstance } = await import("./testspace/TestspaceRetirementSmoke.mjs");
    assert.throws(() => assertRetiredInstance({
        name: "local-worker",
        result: { cleanupPending: false },
        debts: [{ instance: "local-worker", state: "pending", generationId: "still-live" }],
    }), /pending generation debt/u);
});

test("retirement-smoke permits unrelated debts and keeps orphaned records observable", async () => {
    const { assertRetiredInstance } = await import("./testspace/TestspaceRetirementSmoke.mjs");
    assert.doesNotThrow(() => assertRetiredInstance({
        name: "local-worker",
        result: { cleanupPending: false },
        debts: [
            { instance: "other-worker", state: "pending", generationId: "other" },
            { instance: "local-worker", state: "orphaned", generationId: "orphan" },
        ],
    }));
});
