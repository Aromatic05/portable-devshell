import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import { ReverseCredentialStore } from "../../../../src/instance/reverse/credential/Store.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function fixture(t: TestContext) {
    const home = await createTestTempDirectory("reverse-admission-round5");
    t.after(() => rm(home, { recursive: true, force: true }));
    const store = new ReverseCredentialStore(home);
    const enroll = async (instance = "round5-reverse") =>
        (await store.consumeDeviceCode((await store.createDeviceCode(instance)).deviceCode)).deviceToken;
    return { home, store, enroll };
}

test("Round5 queued predecessor admission rechecks credentials after replacement commits", { timeout: 5_000 }, async (t) => {
    const { home, store, enroll } = await fixture(t);
    const first = await enroll();
    const second = await enroll();
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const replacement = store.withAuthenticatedToken("round5-reverse", second, async (replacing) => {
        assert.equal(replacing, true);
        entered.resolve();
        await release.promise;
    });
    await entered.promise;
    let predecessorCalls = 0;
    const queued = store.withAuthenticatedToken("round5-reverse", first, async () => { predecessorCalls += 1; });
    assert.equal(await store.authenticate("round5-reverse", first), true);
    release.resolve();
    assert.equal(await replacement, true);
    assert.equal(await queued, false);
    assert.equal(predecessorCalls, 0);
    const reopened = new ReverseCredentialStore(home);
    assert.equal(await reopened.authenticate("round5-reverse", first), false);
    assert.equal(await reopened.authenticate("round5-reverse", second), true);
});

test("Round5 rejected replacement releases its queue and admits the still valid predecessor", { timeout: 5_000 }, async (t) => {
    const { store, enroll } = await fixture(t);
    const first = await enroll();
    const second = await enroll();
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const failure = new Error("Round5 injected application handshake rejection");
    const replacement = store.withAuthenticatedToken("round5-reverse", second, async () => {
        entered.resolve();
        await release.promise;
        throw failure;
    });
    const rejected = assert.rejects(replacement, (error: unknown) => error === failure);
    await entered.promise;
    let predecessorCalls = 0;
    const queued = store.withAuthenticatedToken("round5-reverse", first, async (replacing) => {
        assert.equal(replacing, false);
        predecessorCalls += 1;
    });
    release.resolve();
    await rejected;
    assert.equal(await queued, true);
    assert.equal(predecessorCalls, 1);
    assert.equal(await store.authenticate("round5-reverse", first), true);
    assert.equal(await store.authenticate("round5-reverse", second), true);
});

test("Round5 blocked admission does not serialize another instance or resurrect a rotated credential", { timeout: 5_000 }, async (t) => {
    const { home, store, enroll } = await fixture(t);
    const first = await enroll();
    const second = await enroll();
    const other = await enroll("round5-other");
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const pending = store.withAuthenticatedToken("round5-reverse", second, async () => {
        entered.resolve();
        await release.promise;
    });
    await entered.promise;
    let calls = 0;
    assert.equal(await store.withAuthenticatedToken("round5-other", other, async (replacing) => {
        assert.equal(replacing, false);
        calls += 1;
    }), true);
    assert.equal(calls, 1);
    const rotated = await store.rotateToken("round5-reverse");
    release.resolve();
    assert.equal(await pending, false);
    const reopened = new ReverseCredentialStore(home);
    assert.equal(await reopened.authenticate("round5-reverse", first), false);
    assert.equal(await reopened.authenticate("round5-reverse", second), false);
    assert.equal(await reopened.authenticate("round5-reverse", rotated), true);
    assert.equal(await reopened.authenticate("round5-other", other), true);
});

test("Round5 revocation wins over an admitted operation and queued replacement", { timeout: 5_000 }, async (t) => {
    const { home, store, enroll } = await fixture(t);
    const first = await enroll();
    const second = await enroll();
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const pending = store.withAuthenticatedToken("round5-reverse", first, async () => {
        entered.resolve();
        await release.promise;
    });
    await entered.promise;
    let replacementCalls = 0;
    const queued = store.withAuthenticatedToken("round5-reverse", second, async () => { replacementCalls += 1; });
    await store.revoke("round5-reverse");
    release.resolve();
    assert.equal(await pending, false);
    assert.equal(await queued, false);
    assert.equal(replacementCalls, 0);
    const reopened = new ReverseCredentialStore(home);
    assert.equal(await reopened.enrollmentState("round5-reverse"), "revoked");
    assert.equal(await reopened.authenticate("round5-reverse", first), false);
    assert.equal(await reopened.authenticate("round5-reverse", second), false);
});
