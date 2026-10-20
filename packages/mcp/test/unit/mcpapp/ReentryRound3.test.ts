import assert from "node:assert/strict";
import test from "node:test";
import { betaReentry } from "../../support/BetaReentry.ts";
import { McpAppActionStore } from "../../../src/mcpapp/ActionStore.ts";

test("round3 Reentry concurrent claims across endpoint instances admit exactly one Host and one Instance execution", async () => {
    const fixture = await betaReentry();
    try {
        const replies = await Promise.all(Array.from({ length: 8 }, (_, index) => fixture.call({ action: "claim", claimId: `host-${index}` })));
        assert.equal(replies.filter((value) => (value as { claimed: boolean }).claimed).length, 1);
        assert.equal(fixture.executions(), 1);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "attempting");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, true);
    } finally { await fixture.close(); }
});

test("round3 Reentry rejects another principal or same-principal foreign Context before reserving a receipt or reading model context", async () => {
    const fixture = await betaReentry();
    try {
        await assert.rejects(fixture.call({ action: "claim" }, "attacker"), { code: "mcp.contextInvalid" });
        const foreign = await fixture.contexts.registry.create({ principal: "owner", environments: [{ instance: "local", workspace: "/other" }] });
        await assert.rejects(fixture.call({ action: "claim", ctxId: foreign.ctxId }), /not owned/u);
        await assert.rejects(fixture.call({ action: "claim", sourceId: "another-goal" }), /not owned/u);
        assert.equal(fixture.executions(), 0);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "applied");
        assert.equal((await fixture.call({ action: "claim" }) as { claimed: boolean }).claimed, true);
        assert.equal(fixture.executions(), 1);
    } finally { await fixture.close(); }
});

test("round3 Reentry dispatch failure restores receipt for retry without leaving an Instance claim", async () => {
    const fixture = await betaReentry();
    try {
        fixture.failClaim(true);
        await assert.rejects(fixture.call({ action: "claim" }), /injected dispatch failure/u);
        assert.equal((await fixture.actions.get(fixture.directiveId))?.status, "applied");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationPending, false);
        fixture.failClaim(false);
        assert.equal((await fixture.call({ action: "claim" }) as { claimed: boolean }).claimed, true);
        assert.equal(fixture.executions(), 2);
    } finally { await fixture.close(); }
});

test("round3 Reentry attempted receipt survives store reload and repeated attempt/report never increments Goal continuation twice", async () => {
    const fixture = await betaReentry();
    try {
        assert.equal((await fixture.call({ action: "claim" }) as { claimed: boolean }).claimed, true);
        assert.equal((await fixture.call({ action: "attempt" }) as { attempted: boolean }).attempted, true);
        const restarted = new McpAppActionStore({ filePath: fixture.filePath });
        await restarted.initialize();
        const endpoint = fixture.endpoint(restarted);
        const before = fixture.executions();
        assert.deepEqual(await fixture.call({ action: "attempt" }, "owner", endpoint), { attempted: false, duplicate: true });
        assert.equal(fixture.executions(), before);
        await fixture.call({ action: "report", outcome: "accepted" }, "owner", endpoint);
        assert.deepEqual(await fixture.call({ action: "report", outcome: "accepted" }, "owner", endpoint), { reported: false });
        assert.equal((await restarted.get(fixture.directiveId))?.status, "settled");
        assert.equal((await fixture.goal.read(fixture.context.ctxId))?.continuationCount, 1);
        assert.equal(fixture.executions(), before + 1);
    } finally { await fixture.close(); }
});
