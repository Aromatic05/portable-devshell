import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";
import { InstanceStateMachine } from "@portable-devshell/core/testing";

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
        daemonState: "running",
        lastErrorCode: "core.workerRpcDisconnected",
        lastErrorMessage: "Worker RPC connection closed unexpectedly."
    });
    assert.equal(failed.ready, false);
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastErrorCode, "core.workerRpcDisconnected");
    assert.equal(failed.lastErrorMessage, "Worker RPC connection closed unexpectedly.");

    const retained = stateMachine.apply({ lastSeq: 5 });
    assert.equal(retained.lastErrorMessage, "Worker RPC connection closed unexpectedly.");

    const stopped = stateMachine.apply({
        connectionState: "disconnected",
        daemonState: "stopped",
        lastErrorCode: undefined,
        lastErrorMessage: undefined
    });
    assert.equal(stopped.ready, false);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.lastErrorCode, undefined);
    assert.equal(stopped.lastErrorMessage, undefined);
});
