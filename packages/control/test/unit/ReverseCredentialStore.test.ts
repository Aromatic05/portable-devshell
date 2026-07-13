import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReverseCredentialStore, reverseRoute } from "../../dist/index.js";

test("reverse device code is single-use and device token is stored in user-only files", async () => {
    const home = await mkdtemp(join(tmpdir(), "devshell-reverse-"));
    const store = new ReverseCredentialStore(home);
    const code = await store.createDeviceCode("remote-test");

    assert.match(code.deviceCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/u);
    const credential = await store.consumeDeviceCode(code.deviceCode.toLowerCase());
    assert.equal(credential.instance, "remote-test");
    assert.equal(await store.authenticate("remote-test", credential.deviceToken), true);

    await assert.rejects(
        store.consumeDeviceCode(code.deviceCode),
        (error: unknown) => hasCode(error, "reverse.deviceCodeConsumed")
    );

    const record = await stat(join(home, ".devshell", "control", "reverse", "remote-test.json"));
    assert.equal(record.mode & 0o777, 0o600);
});

test("issuing a replacement code keeps the old token valid until the code is consumed", async () => {
    const home = await mkdtemp(join(tmpdir(), "devshell-reverse-"));
    const store = new ReverseCredentialStore(home);
    const firstCode = await store.createDeviceCode("remote-test");
    const first = await store.consumeDeviceCode(firstCode.deviceCode);

    const replacementCode = await store.createDeviceCode("remote-test");
    assert.equal(await store.authenticate("remote-test", first.deviceToken), true);

    const replacement = await store.consumeDeviceCode(replacementCode.deviceCode);
    assert.equal(await store.authenticate("remote-test", first.deviceToken), false);
    assert.equal(await store.authenticate("remote-test", replacement.deviceToken), true);
});

test("token rotation and revocation invalidate the previous credential", async () => {
    const home = await mkdtemp(join(tmpdir(), "devshell-reverse-"));
    const store = new ReverseCredentialStore(home);
    const code = await store.createDeviceCode("remote-test");
    const first = await store.consumeDeviceCode(code.deviceCode);
    const rotated = await store.rotateToken("remote-test");

    assert.equal(await store.authenticate("remote-test", first.deviceToken), false);
    assert.equal(await store.authenticate("remote-test", rotated), true);

    await store.revoke("remote-test");
    assert.equal(await store.authenticate("remote-test", rotated), false);
});

test("reverse route follows the public base URL path", () => {
    assert.equal(reverseRoute("https://example.test", "/reverse/v1/connect"), "/reverse/v1/connect");
    assert.equal(
        reverseRoute("https://example.test/devshell/", "/reverse/v1/connect"),
        "/devshell/reverse/v1/connect"
    );
});

function hasCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
