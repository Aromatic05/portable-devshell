import assert from "node:assert/strict";
import test from "node:test";
import { fixture, ping } from "../../packages/control/test/integration/ReverseNetworkRound6Fixture.ts";

// Standalone regression; intentionally excluded from package tests.
// Run without MemorySocketBoundary.mjs for a real localhost TCP reproduction.
test("RED: failed authenticated WSS candidate must leave predecessor RPC usable", { timeout: 8_000 }, async (t) => {
    const f = await fixture(t);
    const token = await f.enroll();
    const original = f.connect(token, 1);
    await original.ready;
    assert.deepEqual(await ping(f.alpha), { pong: true });
    const candidate = f.connect(token, 2, { failHandshake: true });
    await candidate.closed;
    assert.equal(candidate.acks.includes("DSR2:ready"), false);
    assert.equal(f.alpha.supervision.snapshot().ready, true);
    assert.equal(f.alpha.supervision.snapshot().reverse?.generation, 1);
    // Candidate seq 1/2 have overwritten Ingress.#acceptedWss for this descriptor.
    // The retained predecessor's next reply is now rejected as stale generation.
    assert.deepEqual(await ping(f.alpha), { pong: true });
});
