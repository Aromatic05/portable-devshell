import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { ReverseCredentialStore } from "../../../../src/instance/reverse/credential/Store.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((ready) => { resolve = ready; });
    return { promise, resolve };
}

test("reverse replacement revokes predecessor only after the authenticated operation finishes", async (t) => {
    const home = await createTestTempDirectory("r4-reverse-activation-boundary");
    t.after(async () => { await rm(home, { force: true, recursive: true }); });
    const store = new ReverseCredentialStore(home);
    const first = await store.consumeDeviceCode((await store.createDeviceCode("r4-reverse")).deviceCode);
    const second = await store.consumeDeviceCode((await store.createDeviceCode("r4-reverse")).deviceCode);
    const entered = deferred();
    const finish = deferred();
    t.after(() => finish.resolve());
    const activating = store.withAuthenticatedToken("r4-reverse", second.deviceToken, async (replacement) => {
        assert.equal(replacement, true);
        entered.resolve();
        await finish.promise;
    });
    await entered.promise;
    // Transport may be ready while the asynchronous admission transaction still owns the rollover.
    assert.equal(await store.authenticate("r4-reverse", first.deviceToken), true);
    assert.equal(await store.authenticate("r4-reverse", second.deviceToken), true);
    finish.resolve();
    assert.equal(await activating, true);
    assert.equal(await store.authenticate("r4-reverse", first.deviceToken), false);
    assert.equal(await store.authenticate("r4-reverse", second.deviceToken), true);
});

test("failed reverse replacement preserves predecessor until a later completed admission", async (t) => {
    const home = await createTestTempDirectory("r4-reverse-activation-retry");
    t.after(async () => { await rm(home, { force: true, recursive: true }); });
    const store = new ReverseCredentialStore(home);
    const first = await store.consumeDeviceCode((await store.createDeviceCode("r4-reverse")).deviceCode);
    const second = await store.consumeDeviceCode((await store.createDeviceCode("r4-reverse")).deviceCode);
    await assert.rejects(
        store.withAuthenticatedToken("r4-reverse", second.deviceToken, async (replacement) => {
            assert.equal(replacement, true);
            throw new Error("injected Worker handshake failure");
        }),
        /injected Worker handshake failure/u,
    );
    assert.equal(await store.authenticate("r4-reverse", first.deviceToken), true);
    assert.equal(await store.authenticate("r4-reverse", second.deviceToken), true);
    assert.equal(await store.withAuthenticatedToken("r4-reverse", second.deviceToken, async () => {}), true);
    assert.equal(await store.authenticate("r4-reverse", first.deviceToken), false);
    assert.equal(await store.authenticate("r4-reverse", second.deviceToken), true);
});
