import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ContextRegistry } from "../../../control/src/context/registry/index.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const external = { kind: "openai/session", value: "same-untrusted-session-header" };

test("round3 Context identical external session IDs remain principal-isolated across concurrent binding and reload", async () => {
    const filePath = join(await createTestTempDirectory("round3-context-session"), "contexts.json");
    let registry = new ContextRegistry({ filePath });
    await registry.initialize();
    const [alpha, beta] = await Promise.all(["alpha", "beta"].map((principal) => registry.create({
        principal, environments: [{ instance: "demo", workspace: `/${principal}` }],
    })));
    assert.ok(alpha);
    assert.ok(beta);
    await Promise.all([alpha, beta].map((ctx) => registry.attachEnvironment(ctx.ctxId,
        ctx.environments[0]!, { bindings: [external], principal: ctx.principal })));
    registry = new ContextRegistry({ filePath });
    await registry.initialize();
    assert.equal((await registry.lookupExternal(external, { principal: "alpha" }))?.ctxId, alpha.ctxId);
    assert.equal((await registry.lookupExternal(external, { principal: "beta" }))?.ctxId, beta.ctxId);
    assert.equal(await registry.lookupExternal(external, { principal: "attacker" }), undefined);
    await assert.rejects(registry.attachEnvironment(alpha.ctxId, { instance: "demo", workspace: "/stolen" },
        { bindings: [external], principal: "beta" }), { code: "mcp.contextInvalid" });
    assert.equal((await registry.lookup(alpha.ctxId, { principal: "alpha" })).environments[0]?.workspace, "/alpha");
});

test("round3 Context denied touches cannot extend the owner's durable lease or expiry", async () => {
    const filePath = join(await createTestTempDirectory("round3-context-touch"), "contexts.json");
    let now = 1000;
    const registry = new ContextRegistry({ filePath, now: () => now, ttlMs: 1000 });
    await registry.initialize();
    const owner = await registry.create({ principal: "owner", environments: [{ instance: "demo" }] });
    const durable = await readFile(filePath, "utf8");
    now = 1750;
    const denied = await Promise.allSettled(Array.from({ length: 6 }, () => registry.validateAndTouch(owner.ctxId, { principal: "attacker" })));
    assert.equal(denied.length, 6);
    for (const result of denied) {
        assert.equal(result.status, "rejected");
        assert.equal((result as PromiseRejectedResult).reason.code, "mcp.contextInvalid");
    }
    assert.equal(await readFile(filePath, "utf8"), durable);
    assert.equal((await registry.lookup(owner.ctxId, { principal: "owner" })).lastAccessedAt, owner.lastAccessedAt);
    now = 2000;
    await assert.rejects(registry.validateAndTouch(owner.ctxId, { principal: "owner" }), { code: "mcp.contextExpired" });
    const reloaded = new ContextRegistry({ filePath, now: () => now, ttlMs: 1000 });
    await reloaded.initialize();
    await assert.rejects(reloaded.validate(owner.ctxId, { principal: "owner" }), { code: "mcp.contextExpired" });
});

test("round3 Context rebinding one principal's session leaves the other principal and the old explicit Context intact", async () => {
    const registry = new ContextRegistry();
    const old = await registry.create({ principal: "owner", environments: [{ instance: "demo", workspace: "/old" }] });
    const peer = await registry.create({ principal: "peer", environments: [{ instance: "demo", workspace: "/peer" }] });
    const next = await registry.create({ principal: "owner", environments: [{ instance: "demo", workspace: "/next" }] });
    await registry.attachEnvironment(old.ctxId, old.environments[0]!, { principal: "owner", bindings: [external] });
    await registry.attachEnvironment(peer.ctxId, peer.environments[0]!, { principal: "peer", bindings: [external] });
    await registry.attachEnvironment(next.ctxId, next.environments[0]!, { principal: "owner", bindings: [external] });
    assert.equal((await registry.lookupExternal(external, { principal: "owner" }))?.ctxId, next.ctxId);
    assert.equal((await registry.lookupExternal(external, { principal: "peer" }))?.ctxId, peer.ctxId);
    assert.equal((await registry.validate(old.ctxId, { principal: "owner" })).status, "active");
    await assert.rejects(registry.validate(next.ctxId, { principal: "peer" }), { code: "mcp.contextInvalid" });
    const publicRecords = await registry.list();
    assert.equal(JSON.stringify(publicRecords).includes(external.value), false);
});
