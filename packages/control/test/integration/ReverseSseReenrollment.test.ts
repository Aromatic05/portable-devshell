import assert from "node:assert/strict";
import test from "node:test";

import { barrier, fixture, ping, post, sse, until } from "./ReverseNetworkRound6Fixture.ts";

for (const outcome of ["promote", "reject"] as const) {
    test(`equal-generation SSE reenrollment ${outcome} preserves predecessor during real handshake`, { timeout: 10_000 }, async (t) => {
        const f = await fixture(t);
        const previousToken = await f.enroll();
        const first = await sse(t, f.base, previousToken, 1);
        await until(() => f.alpha.supervision.snapshot().ready);
        assert.deepEqual(await ping(f.alpha), { pong: true });
        const previousSequence = first.sequence();
        const replacementToken = await f.enroll();
        const entered = barrier();
        const release = barrier();
        t.after(release.resolve);
        const candidate = await sse(t, f.base, replacementToken, 1, undefined, 0, {
            handshake: async () => { entered.resolve(); await release.promise; },
            failHandshake: outcome === "reject",
        });
        await entered.promise;
        const previousAck = await post(f.base, previousToken, 1, []);
        assert.equal(previousAck.status, 200);
        assert.deepEqual(await previousAck.json(), { acceptedThrough: previousSequence, generation: 1 });
        const candidateAck = await post(f.base, replacementToken, 1, []);
        assert.equal(candidateAck.status, 200);
        assert.deepEqual(await candidateAck.json(), { acceptedThrough: candidate.sequence(), generation: 1 });
        assert.deepEqual(await ping(f.alpha), { pong: true });
        assert.deepEqual(await ping(f.alpha), { pong: true });
        assert.deepEqual(candidate.methods, ["worker.ping", "worker.handshake"]);
        assert.equal(await f.store.authenticate("r6-alpha", previousToken), true);
        assert.equal(await f.store.authenticate("r6-alpha", replacementToken), true);
        release.resolve();
        await (outcome === "promote" ? first.pumping : candidate.pumping);
        await until(async () => (await f.store.authenticate("r6-alpha", previousToken)) === (outcome === "reject"));
        assert.deepEqual(await ping(f.alpha), { pong: true });
        assert.equal(f.alpha.supervision.snapshot().reverse?.generation, 1);
        assert.equal(await f.store.authenticate("r6-alpha", replacementToken), true);
        assert.deepEqual(first.errors, []);
        assert.deepEqual(candidate.errors, []);
    });
}
