import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { createTestTempDirectory } from "../../test/TestTempDirectory.ts";
import { deletionFixture } from "../../packages/control/test/unit/control/instance/Round5DeletionFixture.ts";
import { staleWorkerFixture } from "../../packages/control/test/integration/server/Round5WorkerFixture.ts";

test("RED: actual cleanup retry cannot settle absent Worker process with residual PID after restart", async (t) => {
    const home = await createTestTempDirectory("r5-worker-red");
    t.after(() => rm(home, { recursive: true, force: true }));
    const worker = await staleWorkerFixture(home);
    const command = await worker.client.retireRuntime();
    assert.equal(command.exitCode, 1);
    assert.match(command.stderr, /has stale daemon state; stop it before retirement/);
    const original = await deletionFixture(home, { retireRuntime: () => worker.retirement.retireRuntime() });
    t.after(() => original.close());
    await original.editor.deleteInstance({ instanceName: original.draft.name });
    await original.close();
    const restarted = await deletionFixture(home, { retireRuntime: () => worker.retirement.retireRuntime() }, true);
    t.after(() => restarted.close());
    await restarted.editor.reconcileCleanupDebt(original.draft.name);
    await restarted.editor.reconcileCleanupDebt(original.draft.name);
    assert.deepEqual(await restarted.editor.listCleanupDebts(), [], "Retry alone must settle deleted instance cleanup when no Worker process exists");
});
