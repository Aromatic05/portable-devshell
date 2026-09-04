import assert from "node:assert/strict";
import test from "node:test";

import { assertRunningControlMatchesApplication } from "./install-runtime-identity.mjs";

test("installer accepts a running Control owned by the activated application generation", () => {
    assert.doesNotThrow(() => assertRunningControlMatchesApplication({
        applicationDirectory: "/opt/devshell/versions/0.6.16",
        commandLine: "/usr/bin/node /opt/devshell/versions/0.6.16/node_modules/@portable-devshell/control/dist/server/ControlDaemon.js",
        controlRunning: true,
        pid: 123,
    }));
});

test("installer rejects a stale activation before stopping a different running Control", () => {
    assert.throws(() => assertRunningControlMatchesApplication({
        applicationDirectory: "/opt/devshell/versions/0.6.8",
        commandLine: "/usr/bin/node /opt/devshell/versions/0.6.16/node_modules/@portable-devshell/control/dist/server/ControlDaemon.js",
        controlRunning: true,
        pid: 123,
    }), /running Control.*activated application/iu);
});

test("installer fails closed when a running Control has no verifiable process identity", () => {
    assert.throws(() => assertRunningControlMatchesApplication({
        applicationDirectory: "/opt/devshell/versions/0.6.16",
        commandLine: "",
        controlRunning: true,
        pid: 123,
    }), /cannot verify.*running Control/iu);
});

test("stopped Control does not require a process identity", () => {
    assert.doesNotThrow(() => assertRunningControlMatchesApplication({
        applicationDirectory: "/opt/devshell/versions/0.6.16",
        commandLine: "",
        controlRunning: false,
    }));
});
