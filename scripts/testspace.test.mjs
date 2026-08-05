import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
    buildTestspaceGlobalConfig,
    buildTestspaceInstanceConfig,
    DEFAULT_TESTSPACE_COMMAND,
    resolveTestspaceCommand,
    resolveTestspaceInvocation,
    TESTSPACE_INSTANCE,
    testspaceUrls,
} from "./testspace/TestspaceConfig.mjs";
import { createSafeAction, SAFE_ACTIONS } from "./testspace/TestspaceConnector.mjs";
import {
    createTestspaceProcessEnvironment,
    removeTestspaceDockerContainers,
    resetTestspacePodmanStorage,
    resolveTestspaceRuntimeDirectory,
    stopTestspaceTmux,
} from "./testspace/TestspaceRuntime.mjs";
import {
    assertWebSmokeState,
    resolveChromiumExecutable,
} from "./testspace/TestspaceWebSmoke.mjs";

const require = createRequire(new URL("../packages/control/package.json", import.meta.url));
const toml = require("smol-toml");

test("testspace config enables a complete isolated local instance", () => {
    const global = toml.parse(buildTestspaceGlobalConfig({ mcpPort: 19000, webPort: 19001 }));
    const instance = toml.parse(buildTestspaceInstanceConfig({ workspace: "/tmp/testspace" }));

    assert.deepEqual(global, {
        control: { logLevel: "info" },
        mcp: {
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 19000,
            publicBaseUrl: "http://127.0.0.1:19000",
        },
        version: 2,
        web: {
            auth: "none",
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 19001,
            publicBaseUrl: "http://127.0.0.1:19001",
        },
    });
    assert.equal(instance.name, TESTSPACE_INSTANCE);
    assert.equal(instance.provider, "local");
    assert.equal(instance.workspace, "/tmp/testspace");
    assert.deepEqual(instance.mcp.tools.groups, [
        "file",
        "bash",
        "artifact",
        "tmux",
        "todo",
        "instance",
    ]);
    assert.deepEqual(instance.mcp.tools.capabilities, ["read", "write", "execute", "manage"]);
    assert.deepEqual(instance.security, { mode: "workspace" });
    assert.deepEqual(instance.approvalPolicy, { mode: "allow" });
});

test("testspace URLs point at the isolated instance and Web UI", () => {
    assert.deepEqual(testspaceUrls({ mcpPort: 19000, webPort: 19001 }), {
        mcp: `http://127.0.0.1:19000/${TESTSPACE_INSTANCE}/mcp`,
        web: "http://127.0.0.1:19001/web/",
    });
});

test("testspace starts when invoked without a subcommand", () => {
    assert.equal(DEFAULT_TESTSPACE_COMMAND, "start");
    assert.equal(resolveTestspaceCommand(undefined), "start");
    assert.equal(resolveTestspaceCommand("start"), "start");
    assert.equal(resolveTestspaceCommand("--skip-build"), "start");
    assert.equal(resolveTestspaceCommand("tui"), "tui");
    assert.equal(resolveTestspaceCommand("web"), "web");
    assert.equal(resolveTestspaceCommand("web-smoke"), "web-smoke");
    assert.equal(resolveTestspaceCommand("stop"), "stop");
    assert.equal(resolveTestspaceCommand("status"), "invalid");
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

test("connector safe actions cannot escape into destructive operations", () => {
    assert.deepEqual(SAFE_ACTIONS, ["bash_run", "file_read", "todo_read", "todo_write", "tmux_run"]);
    for (const name of SAFE_ACTIONS) {
        const call = createSafeAction(name, { ctxId: "ctx-test", iteration: 3, revision: 2 });
        assert.equal(call.name, name);
        assert.equal(call.arguments.ctxId, "ctx-test");
        assert.equal("instance" in call.arguments, false);
        if (name === "bash_run" || name === "tmux_run") {
            assert.doesNotMatch(call.arguments.command, /\brm\b|\bmv\b|\bkill\b|\bsudo\b|>|curl|wget/iu);
        }
        if (name === "file_read") {
            assert.equal(call.arguments.path, "./README.md");
        }
    }
});

test("testspace runtime is deterministic and short enough for worker sockets", () => {
    const first = resolveTestspaceRuntimeDirectory("/workspace/portable-devshell");
    const repeated = resolveTestspaceRuntimeDirectory("/workspace/portable-devshell");
    const other = resolveTestspaceRuntimeDirectory("/workspace/portable-devshell-other");

    assert.equal(first, repeated);
    assert.notEqual(first, other);
    assert.equal(
        join(first, "devshell-worker", TESTSPACE_INSTANCE, "worker.sock").length < 100,
        true,
    );
});

test("testspace process environment isolates runtime and container storage", () => {
    const env = createTestspaceProcessEnvironment(
        "/tmp/testspace-home",
        "/tmp/testspace-runtime",
        { PATH: "/usr/bin" },
    );
    assert.equal(env.HOME, "/tmp/testspace-home");
    assert.equal(env.USERPROFILE, "/tmp/testspace-home");
    assert.equal(env.XDG_RUNTIME_DIR, "/tmp/testspace-runtime");
    assert.equal(env.XDG_DATA_HOME, join("/tmp/testspace-home", ".local", "share"));
    assert.equal(env.XDG_CONFIG_HOME, join("/tmp/testspace-home", ".config"));
    assert.equal(env.XDG_CACHE_HOME, join("/tmp/testspace-home", ".cache"));
    assert.equal(env.PATH, "/usr/bin");
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

test("Web smoke requires a non-secure online SPA with the real instance read model", () => {
    const healthy = {
        alerts: [],
        body: "portable-devshell\nOnline\nOverview\ntestspace-local",
        randomUuidType: "undefined",
        secureContext: false,
    };
    assert.doesNotThrow(() => assertWebSmokeState(healthy));
    assert.throws(
        () => assertWebSmokeState({ ...healthy, body: "Offline\nOverview\ntestspace-local" }),
        /did not connect/u,
    );
    assert.throws(
        () => assertWebSmokeState({ ...healthy, alerts: ["transport failed"] }),
        /rendered errors/u,
    );
    assert.throws(
        () => assertWebSmokeState(healthy, [{ method: "Runtime.exceptionThrown" }]),
        /Chromium reported Web failures/u,
    );
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

test("testspace stop terminates its real tmux server", {
    skip: process.platform === "win32" || spawnSync("tmux", ["-V"]).status !== 0,
}, async (t) => {
    const runtime = await mkdtemp(join(tmpdir(), "pds-testspace-runtime-"));
    const socket = join(runtime, "devshell-worker", TESTSPACE_INSTANCE, "tmux.sock");
    await mkdir(dirname(socket), { recursive: true });
    t.after(async () => {
        spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
        await rm(runtime, { force: true, recursive: true });
    });

    const started = spawnSync("tmux", [
        "-S",
        socket,
        "new-session",
        "-d",
        "-s",
        "devshell",
        "sleep 60",
    ], { encoding: "utf8" });
    assert.equal(started.status, 0, started.stderr);
    assert.equal(stopTestspaceTmux(runtime, TESTSPACE_INSTANCE), true);
    assert.notEqual(
        spawnSync("tmux", ["-S", socket, "has-session", "-t", "devshell"]).status,
        0,
    );
});
