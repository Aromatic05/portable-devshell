import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";
import { InstanceStateMachine, WorkerInstanceState } from "../../../../src/instance/runtime/supervision/State.ts";

test("InstanceStateMachine derives ready running stale failed and stopped snapshots", () => {
    const stateMachine = new InstanceStateMachine(
        asInstanceName("task-5-state"),
    );

    assert.equal(stateMachine.snapshot().ready, false);
    assert.equal(stateMachine.snapshot().status, "stopped");

    const starting = stateMachine.apply({
        connectionState: "connecting",
        daemonState: "starting",
    });
    assert.equal(starting.ready, false);
    assert.equal(starting.status, "running");

    const ready = stateMachine.apply({
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 4,
        pid: 1234,
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.status, "ready");
    assert.equal(ready.lastSeq, 4);
    assert.equal(ready.pid, 1234);

    const reconnecting = stateMachine.apply({
        connectionState: "reconnecting",
    });
    assert.equal(reconnecting.ready, false);
    assert.equal(reconnecting.status, "running");

    const stale = stateMachine.apply({
        daemonState: "stale",
    });
    assert.equal(stale.ready, false);
    assert.equal(stale.status, "stale");

    const failed = stateMachine.apply({
        connectionState: "failed",
        daemonState: "running",
        lastErrorCode: "core.workerRpcDisconnected",
        lastErrorMessage: "Worker RPC connection closed unexpectedly.",
    });
    assert.equal(failed.ready, false);
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastErrorCode, "core.workerRpcDisconnected");
    assert.equal(
        failed.lastErrorMessage,
        "Worker RPC connection closed unexpectedly.",
    );

    const retained = stateMachine.apply({ lastSeq: 5 });
    assert.equal(
        retained.lastErrorMessage,
        "Worker RPC connection closed unexpectedly.",
    );

    const stopped = stateMachine.apply({
        connectionState: "disconnected",
        daemonState: "stopped",
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
    });
    assert.equal(stopped.ready, false);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.lastErrorCode, undefined);
    assert.equal(stopped.lastErrorMessage, undefined);
});

test("WorkerInstanceState defers Audit cursor access until a real snapshot", () => {
    let reads = 0;
    const state = new WorkerInstanceState({
        config: { effectiveSecurityMode: "workspace" } as never,
        events: {
            cursor() {
                reads += 1;
                return 42;
            },
            readFrom: () => ({ kind: "events", events: [], lastSeq: 42 }),
        } as never,
        onReadyChanged: async () => undefined,
        stateMachine: new InstanceStateMachine(asInstanceName("stopped-instance")),
    });
    assert.equal(reads, 0, "Control must not open Worker Audit during registration");
    assert.equal(state.snapshot().lastSeq, 42);
    assert.equal(reads, 1);
    assert.equal(state.snapshot().lastSeq, 42);
    assert.equal(reads, 1, "The persisted cursor is read exactly once");
});

test("Worker ready is visible only after asynchronous tool-catalog refresh", async () => {
    let finishRefresh!: () => void;
    const refreshing = new Promise<void>((resolve) => { finishRefresh = resolve; });
    const events: string[] = [];
    const state = new WorkerInstanceState({
        config: { effectiveSecurityMode: "workspace" } as never,
        events: {
            cursor: () => 0,
            readFrom: () => ({ kind: "events", events: [], lastSeq: 0 }),
            append: async (event: { type: string }) => { events.push(event.type); return { seq: events.length }; },
        } as never,
        onReadyChanged: async (ready) => { if (ready) await refreshing; },
        stateMachine: new InstanceStateMachine(asInstanceName("reverse-ready-test")),
    });
    const transition = state.apply({ connectionState: "connected", daemonState: "running" });
    await Promise.resolve();
    assert.equal(state.snapshot().ready, false);
    assert.equal(events.length, 0, "ready cannot be announced before the tool schema is available");
    finishRefresh();
    await transition;
    assert.equal(state.snapshot().ready, true);
    assert.ok(events.includes("instance.readyChanged"));
});
