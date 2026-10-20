import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { deletionFixture } from "../../unit/control/instance/Round5DeletionFixture.ts";
import { realRetirement, staleWorkerFixture } from "./Round5WorkerFixture.ts";

test("Round5 real Rust retirement is idempotent for a missing process and missing instance root", async (t) => {
    const home = await createTestTempDirectory("r5-missing");
    t.after(() => rm(home, { recursive: true, force: true }));
    const worker = realRetirement(home);
    const result = await worker.client.retireRuntime();
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(JSON.parse(result.stdout).retired, false);
    await worker.retirement.retire();
});

test("Round5 stale PID cleanup recovers through retry after a transient stop failure and restart", async (t) => {
    const home = await createTestTempDirectory("r5-stale");
    t.after(() => rm(home, { recursive: true, force: true }));
    const worker = await staleWorkerFixture(home);
    const first = await worker.client.retireRuntime();
    assert.equal(first.exitCode, 1, JSON.stringify(first));
    assert.match(first.stderr, /has stale daemon state; stop it before retirement/);
    t.diagnostic(`Rust retire exit=${first.exitCode} stderr=${first.stderr.trim()}`);
    assert.equal(await readFile(join(worker.root, "artifacts", "retained.txt"), "utf8"), "must survive failed retirement");
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
    const stop = t.mock.method(worker.client, "stop", async () => ({
        exitCode: 23, stdout: "", stderr: "transient stop failure", details: {},
    }) as never);
    const original = await deletionFixture(home, { retireRuntime: () => worker.retirement.retireRuntime() });
    t.after(() => original.close());
    const deleted = await original.editor.deleteInstance({ instanceName: original.draft.name }) as Record<string, unknown>;
    assert.equal(deleted.cleanupPending, true);
    const [before] = await original.editor.listCleanupDebts();
    assert.match(before!.reason!, /Worker runtime stop failed/);
    assert.equal(warnings.length, 1);
    assert.equal(await readFile(join(worker.root, "artifacts", "retained.txt"), "utf8"), "must survive failed retirement");
    await original.close();
    stop.mock.restore();
    const restarted = await deletionFixture(home, { retireRuntime: () => worker.retirement.retireRuntime() }, true);
    t.after(() => restarted.close());
    await restarted.editor.reconcileCleanupDebt(original.draft.name);
    await restarted.editor.reconcileCleanupDebt(original.draft.name);
    assert.deepEqual(await restarted.editor.listCleanupDebts(), []);
    await assert.rejects(readFile(join(worker.root, "artifacts", "retained.txt")), { code: "ENOENT" });
    await restarted.creator.createInstance(original.draft);
    assert.ok(restarted.registry.get(original.draft.name));
});

test("Round5 stale PID pointing to an unrelated running process never terminates that process", { timeout: 10000 }, async (t) => {
    const home = await createTestTempDirectory("r5-reused-pid");
    t.after(() => rm(home, { recursive: true, force: true }));
    const worker = await staleWorkerFixture(home);
    // This test process is live but never owns the isolated Worker's daemon
    // lock. Signalling it would fail the test, rather than touch another user.
    await writeFile(join(worker.root, "state", "worker.pid"), `${process.pid}\n`);
    await worker.retirement.retire();
    await worker.retirement.retire();
    assert.equal(process.kill(process.pid, 0), true);
    await assert.rejects(readFile(join(worker.root, "state", "worker.pid")), { code: "ENOENT" });
    await assert.rejects(readFile(join(worker.root, "artifacts", "retained.txt")), { code: "ENOENT" });
});
