import assert from "node:assert/strict";
import test from "node:test";
import { createRound3Host, deferred } from "./Round3Harness.ts";

test("round3 old same-hash disposal can reenter Host acquisition without retiring the new runtime", async () => {
    const observed: unknown[] = [];
    const fixture = createRound3Host({ dispose: async (number) => {
        if (number === 1) {
            const renewed = await fixture.host.acquireRegistration("cli.native-commands", "matrix");
            observed.push(await (renewed.registration.binding as () => Promise<unknown>)());
            assert.equal(renewed.lease.generation, "same-hash");
            assert.equal(fixture.runtimes[1]!.inFlight, 1);
            renewed.lease.release();
        }
    } });
    await fixture.host.start();
    const old = await fixture.host.acquireRegistration("cli.native-commands", "matrix");
    try {
        await fixture.host.reload("matrix");
        assert.equal(fixture.runtimes[0]!.state, "draining");
        assert.equal(fixture.runtimes[1]!.state, "active");
        old.lease.release();
        await fixture.host.waitForDrain("matrix");
        assert.deepEqual(observed, [{ kind: "text", text: "2" }]);
        assert.deepEqual(fixture.disposed, [1]);
        assert.equal(fixture.runtimes[1]!.state, "active");
        assert.equal(fixture.runtimes[1]!.inFlight, 0);
    } finally { old.lease.release(); await fixture.host.stop(); }
});

test("round3 late fault from an old runtime cannot recover over a same-hash replacement", async () => {
    const fixture = createRound3Host();
    await fixture.host.start();
    const old = await fixture.host.acquireRegistration("cli.native-commands", "matrix");
    try {
        await fixture.host.reload("matrix");
        fixture.runtimes[0]!.fault(new Error("late worker exit"));
        const fresh = await fixture.host.acquireRegistration("cli.native-commands", "matrix");
        assert.equal(fixture.runtimes.length, 2);
        assert.equal(fixture.runtimes[0]!.state, "draining");
        assert.equal(fixture.runtimes[1]!.inFlight, 1);
        fresh.lease.release();
        old.lease.release();
        await fixture.host.waitForDrain("matrix");
        assert.deepEqual(fixture.disposed, [1]);
        assert.equal(fixture.runtimes[1]!.state, "active");
    } finally { old.lease.release(); await fixture.host.stop(); }
});

test("round3 reentrant instance notification may reload without deadlocking Host mutation", async () => {
    const calls: string[] = [];
    const fixture = createRound3Host({ notify: async (number, instance) => {
        calls.push(`${number}:${instance}`);
        await fixture.host.reload("matrix");
    } });
    await fixture.host.start();
    const acquired = await fixture.host.acquireRegistration("cli.native-commands", "matrix");
    acquired.lease.release();
    try {
        await fixture.host.retireInstanceGeneration("a");
        await fixture.host.waitForDrain("matrix");
        assert.deepEqual(calls, ["1:a"]);
        assert.equal(fixture.runtimes.length, 2);
        assert.equal(fixture.runtimes[1]!.state, "active");
    } finally { await fixture.host.stop(); }
});

test("round3 instance cleanup waits for a failing notification and preserves another instance's identity", async () => {
    const entered = deferred();
    const finish = deferred();
    const calls: string[] = [];
    const failure = new Error("notification failed");
    const fixture = createRound3Host({
        notify: async (_number, instance) => {
            calls.push(`notify:${instance}`);
            if (instance === "a") { entered.resolve(); await finish.promise; throw failure; }
        },
        cleanup: async (_number, instance) => { calls.push(`cleanup:${instance}`); },
    });
    await fixture.host.start();
    const acquired = await fixture.host.acquireRegistration("cli.native-commands", "matrix");
    acquired.lease.release();
    try {
        const pending = fixture.host.retireInstanceGeneration("a");
        const rejected = assert.rejects(pending, (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors[0].cause, failure);
            return true;
        });
        await entered.promise;
        await fixture.host.retireInstanceGeneration("b");
        assert.deepEqual(calls, ["notify:a", "notify:b", "cleanup:b"]);
        finish.resolve();
        await rejected;
        assert.deepEqual(calls, ["notify:a", "notify:b", "cleanup:b", "cleanup:a"]);
        assert.equal(fixture.runtimes[0]!.state, "active");
    } finally { finish.resolve(); await fixture.host.stop(); }
});

test("failed old-runtime notification still cleans that runtime and pins asynchronous cleanup across reload", { timeout: 5000 }, async () => {
    const notified = deferred();
    const finishNotification = deferred();
    const cleaning = deferred();
    const finishCleanup = deferred();
    const calls: string[] = [];
    const failure = new Error("old callback failed");
    const fixture = createRound3Host({
        notify: async (runtime, instance) => {
            calls.push(`notify:${runtime}:${instance}`);
            notified.resolve();
            await finishNotification.promise;
            throw failure;
        },
        cleanup: async (runtime, instance) => {
            calls.push(`cleanup:${runtime}:${instance}`);
            cleaning.resolve();
            await finishCleanup.promise;
        },
    });
    await fixture.host.start();
    (await fixture.host.acquireRegistration("cli.native-commands", "matrix")).lease.release();
    const retirement = fixture.host.retireInstanceGeneration("a");
    const rejected = assert.rejects(retirement, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0].cause, failure);
        return true;
    });
    try {
        await notified.promise;
        await fixture.host.reload("matrix");
        assert.equal(fixture.runtimes[0]!.inFlight, 1);
        assert.deepEqual(fixture.disposed, []);
        finishNotification.resolve();
        await cleaning.promise;
        assert.deepEqual(calls, ["notify:1:a", "cleanup:1:a"]);
        assert.equal(fixture.runtimes[0]!.state, "draining");
        assert.equal(fixture.runtimes[0]!.inFlight, 1);
        assert.deepEqual(fixture.disposed, []);
        const fresh = await fixture.host.acquireRegistration("cli.native-commands", "matrix");
        assert.deepEqual(await (fresh.registration.binding as () => Promise<unknown>)(), { kind: "text", text: "2" });
        fresh.lease.release();
        finishCleanup.resolve();
        await rejected;
        await fixture.host.waitForDrain("matrix");
        assert.deepEqual(fixture.disposed, [1]);
        assert.equal(fixture.runtimes[1]!.state, "active");
        assert.equal(fixture.runtimes[1]!.inFlight, 0);
        assert.equal(fixture.host.listDeclarations("cli.native-commands").length, 1);
        assert.equal((await fixture.host.list())[0]!.state, "active");
    } finally {
        finishNotification.resolve();
        finishCleanup.resolve();
        await rejected;
        await fixture.host.stop();
    }
});

for (const fails of [false, true]) {
    test(`Context retirement pins its runtime through reload and Host stop when callback ${fails ? "rejects" : "resolves"}`, { timeout: 5000 }, async () => {
        const entered = deferred();
        const finish = deferred();
        const failure = new Error("context callback failed");
        const events: unknown[] = [];
        const fixture = createRound3Host({ contextRetired: async (runtime, event) => {
            events.push({ runtime, ...event });
            entered.resolve();
            await finish.promise;
            if (fails) throw failure;
        } });
        await fixture.host.start();
        (await fixture.host.acquireRegistration("cli.native-commands", "matrix")).lease.release();
        const pending = fixture.host.contextEnvironmentRetired({ ctxId: "ctx-a", instance: "a", reason: "expired" });
        const observed = fails ? assert.rejects(pending, (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors[0].cause, failure);
            return true;
        }) : pending;
        try {
            await entered.promise;
            await fixture.host.reload("matrix");
            assert.equal(fixture.runtimes[0]!.state, "draining");
            assert.equal(fixture.runtimes[0]!.inFlight, 1);
            assert.deepEqual(fixture.disposed, []);
            const stopping = fixture.host.stop();
            finish.resolve();
            await observed;
            await stopping;
            assert.deepEqual(events, [{ runtime: 1, ctxId: "ctx-a", instance: "a", reason: "expired" }]);
            assert.equal(fixture.runtimes[0]!.inFlight, 0);
            assert.equal(fixture.runtimes[0]!.state, "disposed");
            assert.equal(fixture.runtimes[1]!.state, "disposed");
            assert.deepEqual([...fixture.disposed].sort(), [1, 2]);
        } finally {
            finish.resolve();
            await observed;
            await fixture.host.stop();
        }
    });
}
