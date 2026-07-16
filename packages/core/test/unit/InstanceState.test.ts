import assert from "node:assert/strict";
import test from "node:test";

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
    const paths = new InstancePaths(asInstanceName("task-5-paths"), "/tmp/devshell-home");

    assert.equal(paths.auditDatabaseFile, "/tmp/devshell-home/.devshell/task-5-paths/control-worker/audit.sqlite3");
    assert.equal(paths.legacyEventsFile, "/tmp/devshell-home/.devshell/task-5-paths/control-worker/events.jsonl");
    assert.equal(paths.legacyToolCallsFile, "/tmp/devshell-home/.devshell/task-5-paths/control-worker/tool-calls.jsonl");
    assert.equal(paths.legacyLogsFile, "/tmp/devshell-home/.devshell/task-5-paths/control-worker/logs.jsonl");
    assert.equal(paths.legacyApprovalsFile, "/tmp/devshell-home/.devshell/task-5-paths/control-worker/approvals.jsonl");
    assert.equal(paths.workerConfigFile, "/tmp/devshell-home/.devshell/task-5-paths/config.toml");
    assert.equal(paths.workerLogFile, "/tmp/devshell-home/.devshell/task-5-paths/logs/worker.log");
    assert.equal(paths.workerPidFile, "/tmp/devshell-home/.devshell/task-5-paths/state/worker.pid");
});
