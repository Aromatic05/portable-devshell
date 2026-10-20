import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { createTestTempDirectory } from "../../test/TestTempDirectory.ts";
import { controlDebtFixture } from "../../packages/control/test/integration/server/Round5ControlFixture.ts";

test("RED: Control cleanup retry should recover a deleted local Worker with no process but stale PID residue", { timeout: 20000 }, async (t) => {
    const home = await createTestTempDirectory("r5-control-red");
    t.after(() => rm(home, { recursive: true, force: true }));
    const f = await controlDebtFixture(t, home);
    let instances = await f.connect();
    await instances.retryCleanupDebt("round5-delete");
    await f.control.stop();
    await f.control.start();
    instances = await f.connect();
    const actual = await instances.retryCleanupDebt("round5-delete");
    t.diagnostic(f.warnings.join("\n"));
    assert.deepEqual(actual, [], "User retry after Control restart must settle absent-process cleanup instead of permanently retaining the same debt");
});
