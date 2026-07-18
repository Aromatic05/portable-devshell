import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { asInstanceName } from "@portable-devshell/shared";
import { InstancePaths, InstanceStateMachine } from "@portable-devshell/core/testing";

test("InstanceStateMachine derives ready running stale failed and stopped snapshots", () => {
    const stateMachine = new InstanceStateMachine(asInstanceName("task-5-state"));

    assert.equal(stateMachine.snapshot().ready, false);
    assert.equal(stateMachine.snapshot().status, "stopped");

    const starting = stateMachine.apply({
        connectionState: "connecting",
        daemonState: "starting"
    });
    assert.equal(starting.ready, false);
    assert.equal(starting.status, "running");

    const ready = stateMachine.apply({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 4,
        pid: 1234
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.status, "ready");
    assert.equal(ready.lastSeq, 4);
    assert.equal(ready.pid, 1234);

    const reconnecting = stateMachine.apply({
        connectionState: "reconnecting"
    });
    assert.equal(reconnecting.ready, false);
    assert.equal(reconnecting.status, "running");

    const stale = stateMachine.apply({
        daemonState: "stale"
    });
    assert.equal(stale.ready, false);
    assert.equal(stale.status, "stale");

    const failed = stateMachine.apply({
        connectionState: "failed",
        daemonState: "running"
    });
    assert.equal(failed.ready, false);
    assert.equal(failed.status, "failed");

    const stopped = stateMachine.apply({
        connectionState: "disconnected",
        daemonState: "stopped"
    });
    assert.equal(stopped.ready, false);
    assert.equal(stopped.status, "stopped");
});

test("InstancePaths writes only into per-instance control-worker files", () => {
    const homeDirectory = join("tmp", "devshell-home");
    const instanceRoot = join(homeDirectory, ".devshell", "task-5-paths");
    const controlWorkerRoot = join(instanceRoot, "control-worker");
    const paths = new InstancePaths(asInstanceName("task-5-paths"), homeDirectory);

    assert.equal(paths.auditDatabaseFile, join(controlWorkerRoot, "audit.sqlite3"));
    assert.equal(paths.legacyEventsFile, join(controlWorkerRoot, "events.jsonl"));
    assert.equal(paths.legacyToolCallsFile, join(controlWorkerRoot, "tool-calls.jsonl"));
    assert.equal(paths.legacyLogsFile, join(controlWorkerRoot, "logs.jsonl"));
    assert.equal(paths.legacyApprovalsFile, join(controlWorkerRoot, "approvals.jsonl"));
    assert.equal(paths.workerConfigFile, join(instanceRoot, "config.toml"));
    assert.equal(paths.workerLogFile, join(instanceRoot, "logs", "worker.log"));
    assert.equal(paths.workerPidFile, join(instanceRoot, "state", "worker.pid"));
});
