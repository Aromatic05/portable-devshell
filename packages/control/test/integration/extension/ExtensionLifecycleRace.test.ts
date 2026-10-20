import assert from "node:assert/strict";
import test from "node:test";
import { createRound3Host, deferred } from "./Round3Harness.ts";

test("BUG: Instance retirement must clean the notified old runtime after a concurrent same-hash reload", async () => {
    const entered = deferred();
    const finish = deferred();
    const cleaned: number[] = [];
    const notified: number[] = [];
    const fixture = createRound3Host({
        notify: async (number) => { notified.push(number); entered.resolve(); await finish.promise; },
        cleanup: async (number) => { cleaned.push(number); },
    });
    await fixture.host.start();
    const old = await fixture.host.acquireRegistration("cli.native-commands", "matrix");
    try {
        const retirement = fixture.host.retireInstanceGeneration("instance-a");
        await entered.promise;
        await fixture.host.reload("matrix");
        const replacement = await fixture.host.acquireRegistration("cli.native-commands", "matrix");
        replacement.lease.release();
        assert.equal(fixture.runtimes[0]!.state, "draining");
        assert.equal(fixture.runtimes[1]!.state, "active");
        finish.resolve();
        await retirement;
        console.log("retirement targets", { notified, cleaned, oldInFlight: fixture.runtimes[0]!.inFlight });
        assert.deepEqual(cleaned, [1], "cleanup must retain the notification runtime identity; observed [2] retires new resources and misses old resources");
    } finally { finish.resolve(); old.lease.release(); await fixture.host.stop(); }
});

test("BUG: lifecycle callback must pin its runtime until completion during reload", async () => {
    const entered = deferred();
    const finish = deferred();
    let callbackFinished = false;
    const disposedBeforeFinish: number[] = [];
    const fixture = createRound3Host({
        notify: async () => { entered.resolve(); await finish.promise; callbackFinished = true; },
        dispose: async (number) => { if (!callbackFinished) disposedBeforeFinish.push(number); },
    });
    await fixture.host.start();
    const acquired = await fixture.host.acquireRegistration("cli.native-commands", "matrix");
    acquired.lease.release();
    try {
        const retirement = fixture.host.retireInstanceGeneration("instance-a");
        await entered.promise;
        await fixture.host.reload("matrix");
        assert.equal(fixture.runtimes[0]!.state, "draining");
        assert.equal(fixture.runtimes[0]!.inFlight, 1);
        assert.deepEqual(fixture.disposed, []);
        finish.resolve();
        await retirement;
        await fixture.host.waitForDrain("matrix");
        assert.deepEqual(disposedBeforeFinish, [], "old Extension runtime was disposed while its lifecycle callback was still running");
    } finally { finish.resolve(); await fixture.host.stop(); }
});
