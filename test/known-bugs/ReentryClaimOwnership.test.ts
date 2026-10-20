import assert from "node:assert/strict";
import test from "node:test";
import { betaReentry } from "../../packages/mcp/test/support/BetaReentry.ts";

test("stale Host validate must not release the active Host's receipt", async () => {
    const fixture = await betaReentry();
    try {
        assert.equal((await fixture.call({ action: "claim" }) as { claimed: boolean }).claimed, true);
        assert.equal((await fixture.call({ action: "validate", claimId: "stale-host-claim" }) as { valid: boolean }).valid, false);
        const receipt = await fixture.actions.get(fixture.directiveId);
        const goal = await fixture.goal.read(fixture.context.ctxId);
        const attempted = await fixture.call({ action: "attempt" });
        console.log(JSON.stringify({ receiptStatus: receipt?.status, goalPending: goal?.continuationPending, ownerAttempt: attempted }));
        assert.equal(receipt?.status, "attempting");
        assert.equal((attempted as { attempted: boolean }).attempted, true);
    } finally { await fixture.close(); }
});

test("stale Host uncertain report must not settle the active Host's receipt", async () => {
    const fixture = await betaReentry();
    try {
        await fixture.call({ action: "claim" });
        await fixture.call({ action: "attempt" });
        const result = await fixture.call({ action: "report", outcome: "uncertain", claimId: "stale-host-claim" });
        const receipt = await fixture.actions.get(fixture.directiveId);
        console.log(JSON.stringify({ staleReport: result, receiptStatus: receipt?.status, goalPending: (await fixture.goal.read(fixture.context.ctxId))?.continuationPending }));
        assert.equal(receipt?.status, "attempted");
    } finally { await fixture.close(); }
});
