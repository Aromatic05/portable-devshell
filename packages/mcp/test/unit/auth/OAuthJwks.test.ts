import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { betaOAuth } from "../../support/BetaOAuth.ts";

function restoreBuiltins(t: TestContext) {
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

for (const operation of ["writeFile", "sync", "close", "link"] as const) {
    test(`OAuth JWKS ${operation} failure rejects warmup, cleans its temporary file and permits restart`, async (t) => {
        const directory = await createTestTempDirectory("oauth-jwks-io-failure");
        const canonical = join(directory, "jwks.json");
        const failure = new Error(`injected JWKS ${operation} failure`);
        const open = fs.open;
        t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
            const file = await open(...args);
            if (String(args[0]).startsWith(`${canonical}.`) && args[1] === "wx") {
                if (operation === "writeFile") file.writeFile = async () => {
                    await file.write('{"keys":[');
                    throw failure;
                };
                if (operation === "sync") file.sync = async () => { throw failure; };
                if (operation === "close") {
                    const close = file.close.bind(file);
                    file.close = async () => { await close(); throw failure; };
                }
            }
            return file;
        });
        if (operation === "link") t.mock.method(fs, "link", async () => { throw failure; });
        restoreBuiltins(t);
        const runtime = betaOAuth(directory);
        await assert.rejects(runtime.warmup(), failure);
        assert.throws(() => runtime.provider, /not initialized/u);
        assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
        await assert.rejects(fs.readFile(canonical), { code: "ENOENT" });
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await runtime.warmup();
        assert.equal(JSON.parse(await fs.readFile(canonical, "utf8")).keys.length, 1);
    });
}

test("OAuth JWKS directory sync failure rejects warmup without removing the complete published key", {
    skip: process.platform === "win32" ? "requires POSIX directory fsync semantics" : false,
}, async (t) => {
    const directory = await createTestTempDirectory("oauth-jwks-directory-sync-failure");
    const canonical = join(directory, "jwks.json");
    const failure = new Error("injected JWKS directory sync failure");
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const file = await open(...args);
        if (args[0] === directory && args[1] === "r") file.sync = async () => { throw failure; };
        return file;
    });
    restoreBuiltins(t);
    const runtime = betaOAuth(directory);
    await assert.rejects(runtime.warmup(), failure);
    assert.throws(() => runtime.provider, /not initialized/u);
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
    const source = await fs.readFile(canonical, "utf8");
    assert.equal(JSON.parse(source).keys.length, 1);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await runtime.warmup();
    assert.equal(await fs.readFile(canonical, "utf8"), source);
});

test("OAuth JWKS publishes only a synced complete owner-only file and syncs the directory after temporary cleanup", {
    skip: process.platform === "win32" ? "requires POSIX mode and directory fsync semantics" : false,
}, async (t) => {
    const directory = await createTestTempDirectory("oauth-jwks-durable-publish");
    const canonical = join(directory, "jwks.json");
    const events: string[] = [];
    const open = fs.open;
    const link = fs.link;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const file = await open(...args);
        if (String(args[0]).startsWith(`${canonical}.`) && args[1] === "wx") {
            const sync = file.sync.bind(file);
            file.sync = async () => { await sync(); events.push("file sync"); };
        }
        if (args[0] === directory && args[1] === "r") {
            const sync = file.sync.bind(file);
            file.sync = async () => {
                assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
                await sync();
                events.push("directory sync");
            };
        }
        return file;
    });
    t.mock.method(fs, "link", async (...args: Parameters<typeof link>) => {
        assert.deepEqual(events, ["file sync"]);
        const source = String(args[0]);
        assert.equal(JSON.parse(await fs.readFile(source, "utf8")).keys[0].kty, "RSA");
        assert.equal((await fs.stat(source)).mode & 0o777, 0o600);
        await assert.rejects(fs.readFile(canonical), { code: "ENOENT" });
        await link(...args);
        assert.equal(await fs.readFile(canonical, "utf8"), await fs.readFile(source, "utf8"));
        events.push("publish");
    });
    restoreBuiltins(t);
    await betaOAuth(directory).warmup();
    assert.deepEqual(events, ["file sync", "publish", "directory sync"]);
    const owner = await fs.stat(directory);
    const persisted = await fs.stat(canonical);
    assert.equal(persisted.mode & 0o777, 0o600);
    assert.equal(persisted.uid, owner.uid);
    assert.equal(persisted.gid, owner.gid);
    assert.equal(persisted.nlink, 1);
});

test("OAuth JWKS preserves a legacy private file byte-for-byte without creating or publishing a replacement", async (t) => {
    const directory = await createTestTempDirectory("oauth-jwks-installed");
    await betaOAuth(directory).warmup();
    const canonical = join(directory, "jwks.json");
    const source = await fs.readFile(canonical, "utf8");
    const inode = (await fs.stat(canonical)).ino;
    t.mock.method(fs, "link", async () => { assert.fail("installed JWKS must not be published again"); });
    restoreBuiltins(t);
    await betaOAuth(directory).warmup();
    assert.equal(await fs.readFile(canonical, "utf8"), source);
    assert.equal((await fs.stat(canonical)).ino, inode);
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("OAuth JWKS keeps an already published signing key usable when temporary cleanup fails after effect", async (t) => {
    const directory = await createTestTempDirectory("oauth-jwks-cleanup-after-effect");
    const canonical = join(directory, "jwks.json");
    const rm = fs.rm;
    let failed = false;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof rm>) => {
        await rm(...args);
        if (!failed && String(args[0]).startsWith(`${canonical}.`)) {
            failed = true;
            throw Object.assign(new Error("injected post-cleanup EIO"), { code: "EIO" });
        }
    });
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...values: unknown[]) => { warnings.push(values); });
    restoreBuiltins(t);
    const runtime = betaOAuth(directory);
    await runtime.warmup();
    assert.equal(failed, true);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /temporary cleanup deferred/u);
    const stored = await fs.readFile(canonical, "utf8");
    assert.equal(JSON.parse(stored).keys.length, 1);
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await betaOAuth(directory).warmup();
    assert.equal(await fs.readFile(canonical, "utf8"), stored);
});
