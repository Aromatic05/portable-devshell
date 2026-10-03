import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextRegistry } from "../../../../src/context/Registry/index.js";

test("the reentry owner invalidates a pending claim when execution starts and ignores stale releases", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-reentry" });
    const record = await registry.create({ principal: "user", environments: [{ instance: "local" }] });
    const reentry = registry.reentry;
    const claim = await reentry.claimAutomaticReentry(record.ctxId, "local", "claim-one");
    assert.equal(claim.claimed, true);
    assert.equal(claim.state.pending, true);
    const execution = await reentry.observeExecutionActivity(record.ctxId, "local");
    assert.equal(execution.pending, false);
    assert.equal(execution.executionActive, true);
    assert.equal(execution.executionEpoch, 1);
    assert.equal((await reentry.validateAutomaticReentry(record.ctxId, "local", "claim-one")).valid, false);
    const secondExecution = await reentry.observeExecutionActivity(record.ctxId, "local");
    assert.equal(secondExecution.executionEpoch, 2);
    const stale = await reentry.releaseExecutionActivity(record.ctxId, "local", execution.executionEpoch);
    assert.equal(stale.executionEpoch, secondExecution.executionEpoch);
    assert.equal(stale.executionActive, true);
    const released = await reentry.releaseExecutionActivity(record.ctxId, "local", secondExecution.executionEpoch);
    assert.equal(released.executionEpoch, 3);
    assert.equal(released.executionActive, false);
    assert.equal(registry.changes.revision, 1);
});

test("execution sidecar state survives a new Registry and keeps reentry blocked until lease release", async context => {
    const directory = await mkdtemp(join(tmpdir(), "context-execution-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = join(directory, "contexts.json");
    const first = new ContextRegistry({ filePath, idFactory: () => "ctx-execution" });
    await first.initialize();
    const record = await first.create({ principal: "user", environments: [{ instance: "local" }] });
    const execution = await first.reentry.observeExecutionActivity(record.ctxId, "local");
    const second = new ContextRegistry({ filePath });
    await second.initialize();
    const state = await second.reentry.readAutomaticReentry(record.ctxId, "local");
    assert.equal(state.executionEpoch, execution.executionEpoch);
    assert.equal(state.executionActive, true);
    assert.equal((await second.reentry.claimAutomaticReentry(record.ctxId, "local", "claim-new")).claimed, false);
    await second.reentry.releaseExecutionActivity(record.ctxId, "local", execution.executionEpoch);
    assert.equal((await second.reentry.claimAutomaticReentry(record.ctxId, "local", "claim-new")).claimed, true);
});

test("execution sidecar write failure rejects without falling back to the Context document", async context => {
    const directory = await mkdtemp(join(tmpdir(), "context-execution-write-failure-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = join(directory, "contexts.json");
    const executionFilePath = join(directory, "execution.sqlite");
    const registry = new ContextRegistry({
        executionFilePath,
        filePath,
        idFactory: () => "ctx-write-failure",
    });
    await registry.initialize();
    const record = await registry.create({
        principal: "user",
        environments: [{ instance: "local" }],
    });
    const original = await registry.reentry.observeExecutionActivity(record.ctxId, "local");
    const backupExecutionFilePath = join(directory, "execution.sqlite.backup");
    await rename(executionFilePath, backupExecutionFilePath);
    await mkdir(executionFilePath);

    await assert.rejects(registry.reentry.observeExecutionActivity(record.ctxId, "local"));
    const document = JSON.parse(await readFile(filePath, "utf8")) as {
        contexts: Array<Record<string, unknown>>;
    };
    assert.equal("executionEpoch" in document.contexts[0]!, false);
    assert.equal("executionLeaseUntil" in document.contexts[0]!, false);

    await rm(executionFilePath, { recursive: true });
    await rename(backupExecutionFilePath, executionFilePath);
    const state = await registry.reentry.readAutomaticReentry(record.ctxId, "local");
    assert.equal(state.executionEpoch, original.executionEpoch);
    assert.equal(state.executionLeaseUntil, original.executionLeaseUntil);
});

test("failed sidecar deletion rolls back cleanup settlement and terminal compaction", async context => {
    const directory = await mkdtemp(join(tmpdir(), "context-execution-delete-failure-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = join(directory, "contexts.json");
    const executionFilePath = join(directory, "execution.sqlite");
    const registry = new ContextRegistry({
        executionFilePath,
        filePath,
        idFactory: () => "ctx-delete-failure",
        maxTerminalContexts: 0,
    });
    await registry.initialize();
    const record = await registry.create({
        principal: "user",
        environments: [{ instance: "local" }],
    });
    await registry.reentry.observeExecutionActivity(record.ctxId, "local");
    await registry.disable(record.ctxId);
    const revision = registry.changes.revision;
    await rm(executionFilePath);
    await mkdir(executionFilePath);

    await assert.rejects(registry.settleCleanup(record.ctxId));
    assert.deepEqual(await registry.listCleanupPending(), [
        { ...record, status: "disabled" },
    ]);
    assert.deepEqual(await registry.snapshot(), {
        contexts: [{ ...record, status: "disabled" }],
        revision,
    });
    assert.equal(registry.changes.revision, revision);
});

test("the narrow cleanup ledger refuses settlement until all environment debt is cleared", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-ledger" });
    const record = await registry.create({ principal: "user" });
    await registry.disable(record.ctxId);
    const ledger = registry.cleanupLedger;
    const debt = { instance: "remote", kind: "instance_reference" as const };
    await ledger.recordEnvironmentCleanup(record.ctxId, debt);
    await ledger.recordEnvironmentCleanup(record.ctxId, debt);
    assert.deepEqual(await ledger.listEnvironmentCleanup(record.ctxId), [{ ctxId: record.ctxId, cleanup: debt }]);
    await assert.rejects(ledger.settleCleanup(record.ctxId), /environment cleanup is pending/u);
    await ledger.settleEnvironmentCleanup(record.ctxId, debt);
    await ledger.settleCleanup(record.ctxId);
    assert.deepEqual(await ledger.listEnvironmentCleanup(record.ctxId), []);
    assert.deepEqual(await ledger.listCleanupPending(), []);
    assert.equal(registry.changes.revision, 2);
});
