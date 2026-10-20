import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { ControlPathHome } from "@portable-devshell/shared";
import { ReverseCredentialStore } from "../../../../src/instance/reverse/credential/Store.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { runPersistenceProcess } from "../config/persistence/CrashProcess.ts";

const moduleUrl = new URL("../../../../src/instance/reverse/credential/Store.ts", import.meta.url).href;

for (const published of [false, true]) {
    test(`replacement activation killed ${published ? "after" : "before"} credential rename has deterministic restart admission`, async (t) => {
        const home = await createTestTempDirectory("credential-activation-crash");
        t.after(() => rm(home, { recursive: true, force: true }));
        const store = new ReverseCredentialStore(home);
        const first = await store.consumeDeviceCode((await store.createDeviceCode("remote-crash")).deviceCode);
        const second = await store.consumeDeviceCode((await store.createDeviceCode("remote-crash")).deviceCode);
        const target = new ControlPathHome(home).reverseCredentialFile("remote-crash");
        runPersistenceProcess(`
            import assert from 'node:assert/strict';
            import fs from 'node:fs/promises';
            import { syncBuiltinESMExports } from 'node:module';
            const { home, target, token, published } = JSON.parse(process.argv[1]);
            const rename = fs.rename;
            let activated = false;
            fs.rename = async (...args) => {
                if (args[1] === target && !published) { assert.equal(activated, true); process.kill(process.pid, 'SIGKILL'); }
                await rename(...args);
                if (args[1] === target && published) { assert.equal(activated, true); process.kill(process.pid, 'SIGKILL'); }
            };
            syncBuiltinESMExports();
            const { ReverseCredentialStore } = await import(${JSON.stringify(moduleUrl)});
            await new ReverseCredentialStore(home).withAuthenticatedToken('remote-crash', token, async (replacement) => {
                assert.equal(replacement, true);
                activated = true;
            });
            throw new Error('activation kill boundary not reached');
        `, { home, target, token: second.deviceToken, published }, true);
        const reopened = new ReverseCredentialStore(home);
        assert.equal(await reopened.authenticate("remote-crash", first.deviceToken), !published);
        assert.equal(await reopened.authenticate("remote-crash", second.deviceToken), true);
        let callbacks = 0;
        assert.equal(await reopened.withAuthenticatedToken("remote-crash", second.deviceToken, async (replacement) => {
            callbacks++;
            assert.equal(replacement, !published);
        }), true);
        assert.equal(callbacks, 1);
        const restarted = new ReverseCredentialStore(home);
        assert.equal(await restarted.authenticate("remote-crash", first.deviceToken), false);
        assert.equal(await restarted.authenticate("remote-crash", second.deviceToken), true);
        assert.equal(await restarted.withAuthenticatedToken("remote-crash", first.deviceToken, async () => { callbacks++; }), false);
        assert.equal(callbacks, 1);
    });
}

for (const operation of ["revoke", "retire"] as const) {
    test(`${operation} published before SIGKILL remains terminal across re-enrollment and restart`, async (t) => {
        const home = await createTestTempDirectory("credential-revoke-crash");
        t.after(() => rm(home, { recursive: true, force: true }));
        const store = new ReverseCredentialStore(home);
        const first = await store.consumeDeviceCode((await store.createDeviceCode("remote-crash")).deviceCode);
        const second = await store.consumeDeviceCode((await store.createDeviceCode("remote-crash")).deviceCode);
        const pending = await store.createDeviceCode("remote-crash");
        const target = new ControlPathHome(home).reverseCredentialFile("remote-crash");
        runPersistenceProcess(`
            import fs from 'node:fs/promises';
            import { syncBuiltinESMExports } from 'node:module';
            const { home, target, operation } = JSON.parse(process.argv[1]);
            const rename = fs.rename;
            fs.rename = async (...args) => {
                await rename(...args);
                if (args[1] === target) process.kill(process.pid, 'SIGKILL');
            };
            syncBuiltinESMExports();
            const { ReverseCredentialStore } = await import(${JSON.stringify(moduleUrl)});
            await new ReverseCredentialStore(home)[operation]('remote-crash');
            throw new Error('revocation kill boundary not reached');
        `, { home, target, operation }, true);
        const reopened = new ReverseCredentialStore(home);
        assert.equal(await reopened.enrollmentState("remote-crash"), "revoked");
        assert.equal(await reopened.authenticate("remote-crash", first.deviceToken), false);
        assert.equal(await reopened.authenticate("remote-crash", second.deviceToken), false);
        await assert.rejects(reopened.consumeDeviceCode(pending.deviceCode), { code: "reverse.deviceCodeInvalid" });
        const replacement = await reopened.consumeDeviceCode((await reopened.createDeviceCode("remote-crash")).deviceCode);
        const restarted = new ReverseCredentialStore(home);
        assert.equal(await restarted.authenticate("remote-crash", replacement.deviceToken), true);
        assert.equal(await restarted.authenticate("remote-crash", first.deviceToken), false);
        assert.equal(await restarted.authenticate("remote-crash", second.deviceToken), false);
        let invoked = false;
        assert.equal(await restarted.withAuthenticatedToken("remote-crash", second.deviceToken, async () => { invoked = true; }), false);
        assert.equal(invoked, false);
    });
}

test("a delayed replacement activation cannot erase a newer enrollment's rollover credential", async (t) => {
    const home = await createTestTempDirectory("credential-newer-enrollment");
    t.after(() => rm(home, { recursive: true, force: true }));
    const store = new ReverseCredentialStore(home);
    const first = await store.consumeDeviceCode((await store.createDeviceCode("remote-race")).deviceCode);
    const second = await store.consumeDeviceCode((await store.createDeviceCode("remote-race")).deviceCode);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.after(() => release());
    const activation = store.withAuthenticatedToken("remote-race", second.deviceToken, async (replacement) => {
        assert.equal(replacement, true);
        enter();
        await gate;
    });
    await entered;
    const third = await store.consumeDeviceCode((await store.createDeviceCode("remote-race")).deviceCode);
    release();
    assert.equal(await activation, false);
    const restarted = new ReverseCredentialStore(home);
    assert.equal(await restarted.authenticate("remote-race", first.deviceToken), true);
    assert.equal(await restarted.authenticate("remote-race", second.deviceToken), false);
    assert.equal(await restarted.authenticate("remote-race", third.deviceToken), true);
    assert.equal(await restarted.withAuthenticatedToken("remote-race", third.deviceToken, async (replacement) => {
        assert.equal(replacement, true);
    }), true);
    assert.equal(await new ReverseCredentialStore(home).authenticate("remote-race", first.deviceToken), false);
    assert.equal(await new ReverseCredentialStore(home).authenticate("remote-race", third.deviceToken), true);
});
