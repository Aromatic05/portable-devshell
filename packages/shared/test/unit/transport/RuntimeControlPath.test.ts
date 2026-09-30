import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";

import {
    ControlPathHome,
    resolveControlRuntimeDirectory,
    resolveControlSocketPath,
} from "@portable-devshell/shared";

test("Control home honors PORTABLE_DEVSHELL_HOME unless an explicit homeDirectory is supplied", () => {
    const configured = join("custom", "devshell-home");
    assert.equal(
        new ControlPathHome(undefined, {
            PORTABLE_DEVSHELL_HOME: configured,
        }).controlHomeDir,
        join(configured, "control"),
    );
    assert.equal(
        new ControlPathHome(join("explicit", "home"), {
            PORTABLE_DEVSHELL_HOME: configured,
        }).controlHomeDir,
        join("explicit", "home", ".devshell", "control"),
    );
});

test("Windows named pipe identity never contains path separators", () => {
    const prefix = "\\\\.\\pipe\\";
    const socketPath = resolveControlSocketPath(undefined, "win32", {
        LOCALAPPDATA: "C:\\Temp",
        USERNAME: "DOMAIN\\alice/bob",
    });
    assert.equal(socketPath.startsWith(prefix), true);
    const identity = socketPath.slice(prefix.length);
    assert.equal(identity.includes("\\"), false);
    assert.equal(identity.includes("/"), false);
});

test("long Unix control paths use one deterministic short runtime directory", () => {
    const longRuntime = `/var/folders/${"x".repeat(160)}/T/runtime`;
    const environment = { USER: "alice" };
    const runtimeDir = resolveControlRuntimeDirectory(
        longRuntime,
        "darwin",
        environment,
    );
    const socketPath = resolveControlSocketPath(
        longRuntime,
        "darwin",
        environment,
    );

    assert.equal(dirname(socketPath), runtimeDir);
    assert.ok(Buffer.byteLength(socketPath, "utf8") <= 100, socketPath);
    assert.equal(
        resolveControlRuntimeDirectory(longRuntime, "darwin", environment),
        runtimeDir,
    );
});

test("different long Unix runtime roots do not share a control socket", () => {
    const environment = { USER: "alice" };
    assert.notEqual(
        resolveControlSocketPath(
            `/var/folders/${"a".repeat(160)}`,
            "darwin",
            environment,
        ),
        resolveControlSocketPath(
            `/var/folders/${"b".repeat(160)}`,
            "darwin",
            environment,
        ),
    );
});
