import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { betaOAuth } from "../support/BetaOAuth.ts";
import { oauthJwksEvidence, type OAuthJwksEvidence } from "../support/OAuthJwks.ts";

interface Checkpoint { checkpoint: string; evidence?: OAuthJwksEvidence }

function contender(t: TestContext, directory: string, phase = "race") {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./OAuthJwksProcess.ts", import.meta.url)), directory, phase], {
        stdio: ["ignore", "ignore", "pipe", "ipc"], env: process.env,
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    const messages: Checkpoint[] = [];
    const waiting: Array<(message: Checkpoint) => void> = [];
    child.on("message", (message: Checkpoint) => {
        const resolve = waiting.shift();
        if (resolve) resolve(message);
        else messages.push(message);
    });
    const exited = once(child, "exit");
    t.after(() => { child.kill("SIGKILL"); });
    const next = () => Promise.race([
        messages.length > 0 ? Promise.resolve(messages.shift()!) : new Promise<Checkpoint>((resolve) => { waiting.push(resolve); }),
        exited.then(([code, signal]) => assert.fail(`JWKS child exited before checkpoint: ${code}/${signal}\n${stderr}`)),
    ]);
    return { child, exited, next };
}

async function assertSigningAgreement(directory: string, active: OAuthJwksEvidence[], interrupted: string[] = []) {
    const source = await fs.readFile(join(directory, "jwks.json"), "utf8");
    const persisted = JSON.parse(source) as { keys: Array<Record<string, string>> };
    assert.equal(persisted.keys.length, 1);
    assert.equal(typeof persisted.keys[0]!.d, "string");
    const publicKey = persisted.keys[0]!;
    const restarted = betaOAuth(directory);
    await restarted.warmup();
    const after = await oauthJwksEvidence(restarted);
    for (const evidence of [...active, after]) {
        assert.equal(evidence.jwks.keys.length, 1);
        assert.equal(evidence.jwks.keys[0]!.d, undefined);
        assert.equal(evidence.jwks.keys[0]!.n, publicKey.n);
        assert.equal(evidence.jwks.keys[0]!.e, publicKey.e);
        assert.deepEqual(evidence.jwks, after.jwks);
        await jwtVerify(evidence.signature, createLocalJWKSet(after.jwks), {
            issuer: "http://mcp.example.test", audience: evidence.clientId,
        });
    }
    assert.equal(await fs.readFile(join(directory, "jwks.json"), "utf8"), source);
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), interrupted);
}

test("OAuth simultaneous first starts across processes retain every active signing key after restart", { timeout: 30_000 }, async (t) => {
    const directory = await createTestTempDirectory("oauth-jwks-process-race");
    const children = Array.from({ length: 2 }, () => contender(t, directory));
    for (const child of children) assert.equal((await child.next()).checkpoint, "generated");
    const temporary = (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"));
    assert.equal(temporary.length, 2);
    const candidates = await Promise.all(temporary.map(async (name) => JSON.parse(await fs.readFile(join(directory, name), "utf8"))));
    assert.notEqual(candidates[0].keys[0].n, candidates[1].keys[0].n);
    await assert.rejects(fs.readFile(join(directory, "jwks.json")), { code: "ENOENT" });
    for (const child of children) child.child.send("publish");
    const evidence: OAuthJwksEvidence[] = [];
    for (const child of children) {
        const message = await child.next();
        assert.equal(message.checkpoint, "ready");
        assert.ok(message.evidence);
        evidence.push(message.evidence);
        assert.deepEqual(await child.exited, [0, null]);
    }
    const restarted = contender(t, directory, "restart");
    const message = await restarted.next();
    assert.equal(message.checkpoint, "ready");
    assert.ok(message.evidence);
    evidence.push(message.evidence);
    assert.deepEqual(await restarted.exited, [0, null]);
    await assertSigningAgreement(directory, evidence);
});

test("OAuth simultaneous first starts in separate runtimes use the persisted private key", { timeout: 30_000 }, async (t) => {
    const directory = await createTestTempDirectory("oauth-jwks-runtime-race");
    const canonical = join(directory, "jwks.json");
    const open = fs.open;
    let generated = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const file = await open(...args);
        if (String(args[0]).startsWith(`${canonical}.`) && args[1] === "wx") {
            const sync = file.sync.bind(file);
            file.sync = async () => {
                await sync();
                if (++generated === 2) release();
                await gate;
            };
        }
        return file;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const runtimes = [betaOAuth(directory), betaOAuth(directory)];
    await Promise.all(runtimes.map((runtime) => runtime.warmup()));
    assert.equal(generated, 2);
    await assertSigningAgreement(directory, await Promise.all(runtimes.map(oauthJwksEvidence)));
});

for (const phase of ["writing", "generated"]) {
    test(`OAuth first start survives SIGKILL at ${phase} without publishing partial keys`, {
        timeout: 30_000, skip: process.platform === "win32" ? "requires POSIX SIGKILL evidence" : false,
    }, async (t) => {
        const directory = await createTestTempDirectory(`oauth-jwks-kill-${phase}`);
        const publisher = contender(t, directory, phase);
        const first = await publisher.next();
        assert.equal(first.checkpoint, phase === "writing" ? "writing" : "generated");
        const temporary = (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"));
        assert.equal(temporary.length, 1);
        const interruptedSource = await fs.readFile(join(directory, temporary[0]!), "utf8");
        await assert.rejects(fs.readFile(join(directory, "jwks.json")), { code: "ENOENT" });
        assert.equal(publisher.child.kill("SIGKILL"), true);
        assert.deepEqual(await publisher.exited, [null, "SIGKILL"]);
        const runtime = betaOAuth(directory);
        await runtime.warmup();
        const evidence = await oauthJwksEvidence(runtime);
        await assertSigningAgreement(directory, [evidence], temporary);
        assert.equal(await fs.readFile(join(directory, temporary[0]!), "utf8"), interruptedSource);
    });
}

test("OAuth first start survives publisher SIGKILL after atomic link without replacing the complete winning key", {
    timeout: 30_000, skip: process.platform === "win32" ? "requires POSIX SIGKILL evidence" : false,
}, async (t) => {
    const directory = await createTestTempDirectory("oauth-jwks-kill-linked");
    const publisher = contender(t, directory, "linked");
    assert.equal((await publisher.next()).checkpoint, "generated");
    const temporary = (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"));
    assert.equal(temporary.length, 1);
    const source = await fs.readFile(join(directory, temporary[0]!), "utf8");
    publisher.child.send("publish");
    assert.equal((await publisher.next()).checkpoint, "linked");
    assert.equal(await fs.readFile(join(directory, "jwks.json"), "utf8"), source);
    assert.equal(publisher.child.kill("SIGKILL"), true);
    assert.deepEqual(await publisher.exited, [null, "SIGKILL"]);
    const runtime = betaOAuth(directory);
    await runtime.warmup();
    await assertSigningAgreement(directory, [await oauthJwksEvidence(runtime)], temporary);
    assert.equal(await fs.readFile(join(directory, "jwks.json"), "utf8"), source);
    assert.equal(await fs.readFile(join(directory, temporary[0]!), "utf8"), source);
});
