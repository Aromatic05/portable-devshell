import assert from "node:assert/strict";
import test from "node:test";

import {
    captureInstalledRuntimeState,
    restoreInstalledRuntimeState,
} from "./install-runtime-state.mjs";

test("install runtime state leaves a previously stopped Control stopped", () => {
    const calls = [];
    const state = captureInstalledRuntimeState((args) => {
        calls.push(args);
        return { status: 0, stderr: "", stdout: "control: stopped\n" };
    });

    assert.deepEqual(state, { controlRunning: false, instances: [] });
    assert.deepEqual(calls, [["status"]]);

    restoreInstalledRuntimeState((args) => {
        calls.push(args);
        return { status: 0, stderr: "", stdout: "" };
    }, state);
    assert.deepEqual(calls, [["status"]]);
});

test("install runtime state preserves restart-compatible managed instances", () => {
    const state = captureInstalledRuntimeState((args) => {
        if (args[0] === "status") {
            return { status: 0, stderr: "", stdout: "control: running\npid: 123\ninstances: 6\n" };
        }
        assert.deepEqual(args, ["overview"]);
        return {
            status: 0,
            stderr: "",
            stdout: JSON.stringify({
                instances: [
                    { name: "ready-local", snapshot: { daemonState: "running", reverse: undefined } },
                    { name: "starting-ssh", snapshot: { daemonState: "starting", reverse: undefined } },
                    { name: "stale-local", snapshot: { daemonState: "stale", reverse: undefined } },
                    { name: "stopped-local", snapshot: { daemonState: "stopped", reverse: undefined } },
                    { name: "failed-local", snapshot: { daemonState: "failed", reverse: undefined } },
                    { name: "reverse-node", snapshot: { daemonState: "running", reverse: { connected: true } } },
                ],
            }),
        };
    });

    assert.deepEqual(state, {
        controlRunning: true,
        pid: 123,
        instances: ["ready-local", "starting-ssh", "stale-local"],
    });

    const restored = [];
    restoreInstalledRuntimeState((args) => {
        restored.push(args);
        return { status: 0, stderr: "", stdout: "" };
    }, state);
    assert.deepEqual(restored, [
        ["start"],
        ["instance", "start", "ready-local"],
        ["instance", "start", "starting-ssh"],
        ["instance", "start", "stale-local"],
    ]);
});

test("install runtime state refuses to discard a running Control when its overview cannot be captured", () => {
    assert.throws(
        () => captureInstalledRuntimeState((args) => args[0] === "status"
            ? { status: 0, stderr: "", stdout: "control: running\n" }
            : { status: 1, stderr: "overview failed", stdout: "" }),
        /capture running instances.*overview failed/iu,
    );
});

test("install runtime state rejects an incomplete running overview", () => {
    assert.throws(
        () => captureInstalledRuntimeState((args) => args[0] === "status"
            ? { status: 0, stderr: "", stdout: "control: running\n" }
            : { status: 0, stderr: "", stdout: "{}" }),
        /overview result is missing instances/iu,
    );
});

test("install runtime state reports a failed instance restore", () => {
    const calls = [];
    assert.throws(
        () => restoreInstalledRuntimeState((args) => {
            calls.push(args);
            return {
                status: args.at(-1) === "broken" ? 1 : 0,
                stderr: args.at(-1) === "broken" ? "worker failed" : "",
                stdout: "",
            };
        }, {
            controlRunning: true,
            instances: ["healthy", "broken", "later"],
        }),
        /failed to restore 1 instance/iu,
    );
    assert.deepEqual(calls, [
        ["start"],
        ["instance", "start", "healthy"],
        ["instance", "start", "broken"],
        ["instance", "start", "later"],
    ]);
});
