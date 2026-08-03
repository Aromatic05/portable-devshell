import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
    resolveTestspaceRuntimeDirectory,
    stopTestspaceTmux,
} from "./testspace/TestspaceRuntime.mjs";

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
    assert.equal(resolveTestspaceCommand("stop"), "stop");
    assert.equal(resolveTestspaceCommand("status"), "invalid");
    assert.equal(resolveTestspaceCommand("logs"), "invalid");
    assert.equal(resolveTestspaceCommand("reset"), "invalid");
    assert.deepEqual(resolveTestspaceInvocation([]), { args: [], command: "start" });
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
