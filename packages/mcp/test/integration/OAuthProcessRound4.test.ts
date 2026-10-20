import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { rm } from "node:fs/promises";
import test from "node:test";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

interface RestartEvidence {
    clientId: string;
    clientDigest: string;
    metadata: Record<string, unknown>;
    jwks: { keys: Array<Record<string, unknown>> };
    privateDigest: string;
    signature: string;
    verified: { clientId: string; expiresAt: number; grantId: string; scopes: string[] };
}

test("round4 isolated-runtime restart preserves usable JWKS and durable access revocation", async (t) => {
    const directory = await createTestTempDirectory("round4-oauth-isolate-restart");
    t.after(() => rm(directory, { recursive: true, force: true }));
    const child = async (phase: string, signature = ""): Promise<RestartEvidence> => {
        const worker = new Worker(new URL("./OAuthProcessRound4.ts", import.meta.url), {
            execArgv: ["--import", "tsx"], workerData: [directory, phase, signature],
        });
        let result: RestartEvidence | undefined;
        const code = await new Promise<number>((resolve, reject) => {
            worker.on("message", (value) => { result = value; });
            worker.once("error", reject);
            worker.once("exit", resolve);
        });
        assert.equal(code, 0);
        assert.ok(result, "isolated runtime must publish verification evidence");
        return result;
    };
    const before = await child("seed");
    const after = await child("reload", before.signature);
    assert.equal(after.clientId, before.clientId);
    assert.equal(after.clientDigest, before.clientDigest);
    assert.deepEqual(after.metadata, before.metadata);
    assert.deepEqual(after.jwks, before.jwks);
    assert.equal(after.jwks.keys.length, 1);
    assert.equal(after.jwks.keys[0].d, undefined);
    assert.equal(after.privateDigest, before.privateDigest);
    assert.deepEqual(after.verified, before.verified);
    assert.equal(after.verified.clientId, "restart-client");
    t.diagnostic("two fresh Worker isolates with separate module caches; real OIDC GET /jwks via memory HTTP; no TCP/browser/process restart claim");
});
