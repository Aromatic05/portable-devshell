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
    const home = await createTestTempDirectory("reverse-network-round6-store");
    t.after(() => rm(home, { recursive: true, force: true }));
    const store = new ReverseCredentialStore(home);
    const enroll = async (name = "r6-alpha") =>
        (await store.consumeDeviceCode((await store.createDeviceCode(name)).deviceCode)).deviceToken;
    return { home, store, enroll };
}

test("Round6 reenrollment during replacement admission retains the original predecessor until newest admission commits", { timeout: 5_000 }, async (t) => {
    const f = await fixture(t);
    const original = await f.enroll();
    const intermediate = await f.enroll();
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const intermediateAdmission = f.store.withAuthenticatedToken("r6-alpha", intermediate, async (replacing) => {
        assert.equal(replacing, true);
        entered.resolve();
        await release.promise;
    });
    await entered.promise;
    const newest = await f.enroll();
    const reopened = new ReverseCredentialStore(f.home);
    assert.equal(await reopened.authenticate("r6-alpha", original), true);
    assert.equal(await reopened.authenticate("r6-alpha", intermediate), false);
    assert.equal(await reopened.authenticate("r6-alpha", newest), true);
    release.resolve();
    assert.equal(await intermediateAdmission, false);
    assert.equal(await reopened.authenticate("r6-alpha", original), true);
    assert.equal(await reopened.authenticate("r6-alpha", newest), true);
    assert.equal(await f.store.withAuthenticatedToken("r6-alpha", newest, async (replacing) => {
        assert.equal(replacing, true);
    }), true);
    assert.equal(await reopened.authenticate("r6-alpha", original), false);
    assert.equal(await reopened.authenticate("r6-alpha", intermediate), false);
    assert.equal(await reopened.authenticate("r6-alpha", newest), true);
});

test("Round6 delayed admission finishing after retirement and fresh enrollment cannot revoke the new credential", { timeout: 5_000 }, async (t) => {
    const f = await fixture(t);
    const original = await f.enroll();
    const pending = await f.enroll();
    const entered = barrier();
    const release = barrier();
    t.after(release.resolve);
    const admission = f.store.withAuthenticatedToken("r6-alpha", pending, async () => {
        entered.resolve();
        await release.promise;
    });
    await entered.promise;
    assert.equal(await f.store.retire("r6-alpha"), true);
    const fresh = await f.enroll();
    const betaOld = await f.enroll("r6-beta");
    const betaNew = await f.enroll("r6-beta");
    assert.equal(await f.store.withAuthenticatedToken("r6-beta", betaNew, async (replacing) => {
        assert.equal(replacing, true);
    }), true);
    const reopened = new ReverseCredentialStore(f.home);
    assert.equal(await reopened.authenticate("r6-beta", betaOld), false);
    assert.equal(await reopened.authenticate("r6-beta", betaNew), true);
    release.resolve();
    assert.equal(await admission, false);
    assert.equal(await reopened.enrollmentState("r6-alpha"), "enrolled");
    assert.equal(await reopened.authenticate("r6-alpha", original), false);
    assert.equal(await reopened.authenticate("r6-alpha", pending), false);
    assert.equal(await reopened.authenticate("r6-alpha", fresh), true);
    assert.equal(await f.store.withAuthenticatedToken("r6-alpha", fresh, async (replacing) => {
        assert.equal(replacing, false, "retired credentials cannot authorize generation rewind as a predecessor");
    }), true);
});
