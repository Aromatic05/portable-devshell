import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
    buildTestspaceGlobalConfig,
    buildTestspaceInstanceConfig,
    DEFAULT_TESTSPACE_COMMAND,
    resolveTestspaceCommand,
    TESTSPACE_INSTANCE,
    testspaceUrls,
} from "./testspace/TestspaceConfig.mjs";
import { createSafeAction, SAFE_ACTIONS } from "./testspace/TestspaceConnector.mjs";

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
    assert.equal(resolveTestspaceCommand("tui"), "tui");
    assert.equal(resolveTestspaceCommand("web"), "web");
    assert.equal(resolveTestspaceCommand("stop"), "stop");
    assert.equal(resolveTestspaceCommand("start"), "invalid");
    assert.equal(resolveTestspaceCommand("status"), "invalid");
    assert.equal(resolveTestspaceCommand("logs"), "invalid");
    assert.equal(resolveTestspaceCommand("reset"), "invalid");
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
