import assert from "node:assert/strict";
import test from "node:test";

import { ControlDaemon } from "../../dist/testing.js";

test("a stopping daemon preserves successor lifecycle state", async () => {
    const lifecycle = { pid: "old", socket: "old" };
    const daemon = new ControlDaemon({
        logger: {
            async info() {},
            path: "/tmp/control.log"
        } as never,
        pidFile: {
            async write() {
                lifecycle.pid = "old";
            }
        } as never,
        server: {
            async start() {},
            async stop() {}
        } as never,
        socketFile: {
            async ensureRuntimeDir() {}
        } as never
    });

    await daemon.start();
    lifecycle.pid = "new";
    lifecycle.socket = "new";

    await daemon.stop();

    assert.deepEqual(lifecycle, { pid: "new", socket: "new" });
});

test("a daemon tears down a started server when pid publication fails", async () => {
    let stopCalls = 0;
    const daemon = new ControlDaemon({
        logger: {
            async info() {},
            path: "/tmp/control.log"
        } as never,
        pidFile: {
            async write() {
                throw new Error("pid write failed");
            }
        } as never,
        server: {
            async start() {},
            async stop() {
                stopCalls += 1;
            }
        } as never,
        socketFile: {
            async ensureRuntimeDir() {}
        } as never
    });

    await assert.rejects(daemon.start(), /pid write failed/u);

    assert.equal(stopCalls, 1);
});

test("a stop requested during startup runs after startup completes", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
    });
    const calls: string[] = [];
    const daemon = new ControlDaemon({
        logger: {
            async info() {},
            path: "/tmp/control.log"
        } as never,
        pidFile: {
            async write() {
                calls.push("pid");
            }
        } as never,
        server: {
            async start() {
                calls.push("start");
                await startGate;
            },
            async stop() {
                calls.push("stop");
            }
        } as never,
        socketFile: {
            async ensureRuntimeDir() {}
        } as never
    });

    const starting = daemon.start();
    await waitFor(() => calls.includes("start"));
    const stopping = daemon.stop();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(calls, ["start"]);

    releaseStart();
    await Promise.all([starting, stopping]);

    assert.deepEqual(calls, ["start", "pid", "stop"]);
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for condition.");
}
