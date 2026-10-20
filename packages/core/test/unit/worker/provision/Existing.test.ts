import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import { existingFixture, existingId, replacementId } from "./ExistingHarness.ts";

const mutations = (calls: Array<{ operation: string; args: readonly string[] }>) => calls.filter(({ args }) => args[0] !== "inspect");

test("Existing reconstructs durable adoption with the verified stable container ID", async (t) => {
    const f = await existingFixture(t);
    await f.provision().ensureReady("start");
    const resumed = f.provision({ ...f.adoption });
    assert.equal(await resumed.isAvailable(), true);
    await resumed.ensureReady("connectChannel");
    assert.equal(f.target(), existingId);
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId]]);
    await resumed.afterWorkerStop();
    assert.equal(f.state()?.status, "stopped");
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId], ["stop", existingId]]);
});

test("Existing rejects an unproven running container for every runtime entry point", async (t) => {
    const f = await existingFixture(t);
    f.replace(existingId);
    const provision = f.provision();
    await assert.rejects(provision.ensureReady("start"), /already running/u);
    await assert.rejects(provision.isAvailable(), /already running/u);
    await assert.rejects(provision.prepareRuntimeRetire(), /already running/u);
    await assert.rejects(provision.afterWorkerStop(), /already running/u);
    assert.deepEqual(mutations(f.calls), []);
});

test("Existing invalidates durable provenance when a same-name container is replaced", async (t) => {
    const f = await existingFixture(t);
    const first = f.provision();
    await first.ensureReady("start");
    f.replace();
    await assert.rejects(first.isAvailable(), /already running/u);
    await assert.rejects(f.provision().afterWorkerStop(), /already running/u);
    f.replace(existingId);
    await assert.rejects(f.provision().isAvailable(), /already running/u);
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId]]);
});

test("Existing refuses external restart of the same stable ID and invalidates its old start identity", async (t) => {
    const f = await existingFixture(t);
    await f.provision().ensureReady("start");
    f.externalRestart();
    await assert.rejects(f.provision().isAvailable(), /already running/u);
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId]]);
});

test("Existing config ownership and explicit generation cannot borrow another adoption", async (t) => {
    const f = await existingFixture(t);
    await f.provision({ ...f.adoption, generation: "generation-1" }).ensureReady("start");
    await assert.rejects(f.provision({ ...f.adoption, owner: "instance-beta/config-1" }).isAvailable(), /already running/u);
    await assert.rejects(f.provision({ ...f.adoption, generation: "generation-2" }).isAvailable(), /generation changed/u);
    assert.equal(await f.provision({ ...f.adoption, generation: "generation-1" }).isAvailable(), true);
});

test("Existing failed start creates no adoption and a stopped-container retry succeeds", async (t) => {
    const f = await existingFixture(t);
    f.fail("startContainer");
    await assert.rejects(f.provision().ensureReady("start"), /injected/u);
    assert.equal(f.state()?.status, "stopped");
    await f.provision().ensureReady("start");
    assert.equal(await f.provision().isAvailable(), true);
    assert.equal(mutations(f.calls).length, 2);
});

test("Existing ambiguous start failure never grants ownership of a running container", async (t) => {
    const f = await existingFixture(t);
    f.fail("startContainer", true);
    await assert.rejects(f.provision().ensureReady("start"), /injected/u);
    assert.equal(f.state()?.status, "running");
    await assert.rejects(f.provision().isAvailable(), /already running/u);
    assert.equal(mutations(f.calls).length, 1);
});

test("Existing failed stop preserves provenance and supports reconstruction and retry", async (t) => {
    const f = await existingFixture(t);
    await f.provision().ensureReady("start");
    f.fail("stopContainer");
    await assert.rejects(f.provision().afterWorkerStop(), /injected/u);
    assert.equal(await f.provision().isAvailable(), true);
    await f.provision().afterWorkerStop();
    f.externalRestart();
    await assert.rejects(f.provision().isAvailable(), /already running/u);
});

test("Existing without lifecycle adoption preserves external container and clears its marker after worker stop", async (t) => {
    const f = await existingFixture(t, false);
    const provision = f.provision();
    await provision.ensureReady("start");
    await provision.afterWorkerStop();
    assert.equal(f.state()?.status, "running");
    await assert.rejects(f.provision().isAvailable(), /already running/u);
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId]]);
});

test("Existing concurrent reconstructed starts serialize into one adoption and one provider start", async (t) => {
    const f = await existingFixture(t);
    const provisions = Array.from({ length: 8 }, () => f.provision());
    await Promise.all(provisions.map((provision) => provision.ensureReady("start")));
    assert.deepEqual(await Promise.all(provisions.map((provision) => provision.isAvailable())), Array(8).fill(true));
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId]]);
});

test("Existing concurrent different owners cannot claim the same persisted adoption", async (t) => {
    const f = await existingFixture(t);
    const outcomes = await Promise.allSettled([
        f.provision().ensureReady("start"),
        f.provision({ ...f.adoption, owner: "foreign-generation" }).ensureReady("start"),
    ]);
    assert.deepEqual(outcomes.map(({ status }) => status), ["fulfilled", "rejected"]);
    assert.equal(mutations(f.calls).length, 1);
});

test("Existing stale runtime cannot stop or retire a later adoption generation", async (t) => {
    const f = await existingFixture(t);
    const stale = f.provision();
    await stale.ensureReady("start");
    await f.provision().afterWorkerStop();
    const current = f.provision();
    await current.ensureReady("start");
    await assert.rejects(stale.afterWorkerStop(), /generation changed/u);
    await stale.retire();
    assert.equal(await current.isAvailable(), true);
    assert.equal(f.state()?.status, "running");
});

test("Existing retirement invalidates provenance without deleting the external resource", async (t) => {
    const f = await existingFixture(t);
    const provision = f.provision();
    await provision.ensureReady("start");
    await provision.retire();
    assert.equal(f.state()?.status, "running");
    await assert.rejects(f.provision().isAvailable(), /already running/u);
    await assert.rejects(provision.ensureReady("start"), /retired/u);
    assert.equal(mutations(f.calls).length, 1);
});

test("Existing temporary retirement start is ID pinned, restores stop and retries a failed stop", async (t) => {
    const f = await existingFixture(t);
    const provision = f.provision();
    assert.equal(await provision.prepareRuntimeRetire(), true);
    f.fail("stopContainerAfterRetire");
    await assert.rejects(provision.finishRuntimeRetire(), /injected/u);
    await provision.finishRuntimeRetire();
    await provision.finishRuntimeRetire();
    assert.equal(f.state()?.status, "stopped");
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId], ["stop", existingId], ["stop", existingId]]);
});

test("Existing temporary retirement refuses to stop a replacement container", async (t) => {
    const f = await existingFixture(t);
    const provision = f.provision();
    assert.equal(await provision.prepareRuntimeRetire(), true);
    f.replace();
    await assert.rejects(provision.finishRuntimeRetire(), /identity changed/u);
    assert.equal(f.state()?.id, replacementId);
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId]]);
});

test("Existing missing resources clear stale provenance and never trigger provider mutation", async (t) => {
    const f = await existingFixture(t);
    await f.provision().ensureReady("start");
    f.remove();
    assert.equal(await f.provision().isAvailable(), false);
    assert.equal(await f.provision().prepareRuntimeRetire(), false);
    await assert.rejects(f.provision().ensureReady("start"), /does not exist/u);
    f.replace(existingId);
    await assert.rejects(f.provision().isAvailable(), /already running/u);
    assert.equal(mutations(f.calls).length, 1);
});

test("Existing inspection failure preserves a valid marker and propagates the error", async (t) => {
    const f = await existingFixture(t);
    await f.provision().ensureReady("start");
    f.fail("inspectContainerIdentity");
    await assert.rejects(f.provision().isAvailable(), /injected/u);
    assert.equal(await f.provision().isAvailable(), true);
});

test("Existing damaged provenance fails closed before provider mutation", async (t) => {
    const f = await existingFixture(t);
    await writeFile(f.adoption.databaseFile, "corrupt sqlite database");
    await assert.rejects(f.provision().ensureReady("start"), /not a database/u);
    assert.deepEqual(f.calls, []);
});

test("Existing replacement between stopped inspection and start never starts the replacement ID", async (t) => {
    const f = await existingFixture(t);
    f.intercept(async (operation) => {
        if (operation === "startContainer") f.replace(replacementId, "stopped");
    });
    await assert.rejects(f.provision().ensureReady("start"), /could not be verified/u);
    assert.equal(f.state()?.status, "stopped");
    assert.equal(f.state()?.id, replacementId);
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId]]);
});

test("Existing provider executable and backend cannot borrow another adoption identity", async (t) => {
    const f = await existingFixture(t);
    f.operations.binary = "/isolated/provider-one";
    await f.provision().ensureReady("start");
    f.operations.binary = "/isolated/provider-two";
    await assert.rejects(f.provision().isAvailable(), /already running/u);
    f.operations.binary = "/isolated/provider-one";
    assert.equal(await f.provision().isAvailable(), true);
    f.operations.provider = "docker";
    await assert.rejects(f.provision().isAvailable(), /already running/u);
    assert.equal(mutations(f.calls).length, 1);
});

test("Existing invalidation cannot let a stale runtime borrow a replacement's later adoption generation", async (t) => {
    const f = await existingFixture(t);
    const stale = f.provision();
    await stale.ensureReady("start");
    f.replace();
    await assert.rejects(stale.isAvailable(), /already running/u);
    f.replace(replacementId, "stopped");
    const current = f.provision();
    await current.ensureReady("start");
    await assert.rejects(stale.afterWorkerStop(), /generation changed/u);
    assert.equal(await current.isAvailable(), true);
    assert.equal(f.state()?.status, "running");
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId], ["start", replacementId]]);
});

test("Existing intentional stop keeps the old runtime fenced from another runtime's later generation", async (t) => {
    const f = await existingFixture(t);
    const stale = f.provision();
    await stale.ensureReady("start");
    await stale.afterWorkerStop();
    const current = f.provision();
    await current.ensureReady("start");
    await assert.rejects(stale.afterWorkerStop(), /generation changed/u);
    assert.equal(await current.isAvailable(), true);
    assert.deepEqual(mutations(f.calls).map(({ args }) => args), [["start", existingId], ["stop", existingId], ["start", existingId]]);
});
