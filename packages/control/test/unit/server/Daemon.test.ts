import assert from "node:assert/strict";
import test from "node:test";

import { ControlDaemon } from "../../../src/testing.ts";

test("a stopping daemon preserves successor lifecycle state", async () => {
    const lifecycle = { pid: "old", socket: "old" };
    const daemon = new ControlDaemon({
        logger: {
            async info() {},
            path: "/tmp/control.log",
        } as never,
        pidFile: {
            async write() {
                lifecycle.pid = "old";
            },
        } as never,
        server: {
            async start() {},
            async stop() {},
        } as never,
        socketFile: {
            async ensureRuntimeDir() {},
        } as never,
    });

    await daemon.start();
    lifecycle.pid = "new";
    lifecycle.socket = "new";

    await daemon.stop();

    assert.deepEqual(lifecycle, { pid: "new", socket: "new" });
});

test("a daemon tears down a started server when pid publication fails", async () => {
    let stopCalls = 0;
    const publicationFailure = new Error("pid write failed");
    const daemon = new ControlDaemon({
        logger: {
            async info() {},
            path: "/tmp/control.log",
        } as never,
        pidFile: {
            async write() {
                throw publicationFailure;
            },
        } as never,
        server: {
            async start() {},
            async stop() {
                stopCalls += 1;
            },
        } as never,
        socketFile: {
            async ensureRuntimeDir() {},
        } as never,
    });

    await assert.rejects(
        daemon.start(),
        (error: unknown) => error === publicationFailure,
    );

    assert.equal(stopCalls, 1);
});

test("a failed daemon rollback preserves state and aggregates rollback failure", async () => {
    let stopCalls = 0;
    const publicationFailure = new Error("pid write failed");
    const rollbackFailure = new Error("rollback failed");
    const daemon = new ControlDaemon({
        logger: {
            async info() {},
            path: "/tmp/control.log",
        } as never,
        pidFile: {
            async write() {
                throw publicationFailure;
            },
        } as never,
        server: {
            async start() {},
            async stop() {
                stopCalls += 1;
                if (stopCalls === 1) throw rollbackFailure;
            },
        } as never,
        socketFile: { async ensureRuntimeDir() {} } as never,
    });

    await assert.rejects(
        daemon.start(),
        (error: unknown) =>
            error instanceof AggregateError &&
            error.errors.length === 2 &&
            error.errors[0] === publicationFailure &&
            error.errors[1] === rollbackFailure,
    );

    await daemon.stop();
    assert.equal(stopCalls, 2);
});

test("a failed daemon stop never logs that the server stopped", async () => {
    const logs: string[] = [];
    const stopFailure = new Error("stop failed");
    const daemon = new ControlDaemon({
        logger: {
            async info(message: string) {
                logs.push(message);
            },
            path: "/tmp/control.log",
        } as never,
        pidFile: { async write() {} } as never,
        server: {
            async start() {},
            async stop() {
                throw stopFailure;
            },
        } as never,
        socketFile: { async ensureRuntimeDir() {} } as never,
    });

    await daemon.start();
    await assert.rejects(
        daemon.stop(),
        (error: unknown) =>
            error instanceof AggregateError &&
            error.errors.includes(stopFailure),
    );
    assert.equal(logs.includes("control server stopped"), false);
});

test("a stop requested during startup runs after startup completes", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
    });
    const calls: string[] = [];
    let startCompleted = false;
    let stopOverlappedStart = false;
    const daemon = new ControlDaemon({
        logger: {
            async info() {},
            path: "/tmp/control.log",
        } as never,
        pidFile: {
            async write() {
                calls.push("pid");
            },
        } as never,
        server: {
            async start() {
                calls.push("start");
                await startGate;
                startCompleted = true;
            },
            async stop() {
                if (!startCompleted) stopOverlappedStart = true;
                calls.push("stop");
            },
        } as never,
        socketFile: {
            async ensureRuntimeDir() {},
        } as never,
    });

    const starting = daemon.start();
    await waitFor(() => calls.includes("start"));
    const stopping = daemon.stop();

    releaseStart();
    await Promise.all([starting, stopping]);

    assert.deepEqual(calls, ["start", "pid", "stop"]);
    assert.equal(stopOverlappedStart, false);
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("Timed out waiting for condition.");
}
