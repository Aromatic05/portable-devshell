import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "../../../shared/dist/types/InstanceName.js";

import { InstancePaths } from "../../dist/instance/paths/InstancePaths.js";
import { InstanceStateMachine } from "../../dist/instance/state/InstanceStateMachine.js";

test("InstanceStateMachine derives ready running stale and stopped snapshots", () => {
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

    const stale = stateMachine.apply({
        connectionState: "disconnected"
    });
    assert.equal(stale.ready, false);
    assert.equal(stale.status, "stale");

    const stopped = stateMachine.apply({
        daemonState: "stopped"
    });
    assert.equal(stopped.ready, false);
    assert.equal(stopped.status, "stopped");
});

test("InstancePaths writes only into per-instance control-worker files", () => {
    const paths = new InstancePaths(asInstanceName("task-5-paths"), "/tmp/devshell-home");

    assert.equal(paths.eventsFile, "/tmp/devshell-home/.devshell/task-5-paths/control-worker/events.jsonl");
    assert.equal(paths.toolCallsFile, "/tmp/devshell-home/.devshell/task-5-paths/control-worker/tool-calls.jsonl");
    assert.equal(paths.logsFile, "/tmp/devshell-home/.devshell/task-5-paths/control-worker/logs.jsonl");
    assert.equal(paths.workerConfigFile, "/tmp/devshell-home/.devshell/task-5-paths/config.toml");
    assert.equal(paths.workerLogFile, "/tmp/devshell-home/.devshell/task-5-paths/logs/worker.log");
    assert.equal(paths.workerPidFile, "/tmp/devshell-home/.devshell/task-5-paths/state/worker.pid");
});
