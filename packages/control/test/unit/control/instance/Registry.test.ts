import assert from "node:assert/strict";
import test from "node:test";

import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
} from "@portable-devshell/shared";

import { ControlInstances } from "../../../../src/instance/index.ts";
import { InstanceRegistry } from "../../../../src/instance/Registry.ts";
import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { createTestInstance } from "../../../support/InstanceRuntime.ts";

test("ControlInstances loads only enabled instance generations without starting workers", async (t) => {
    const config = createDefaultControlConfig();
    config.instances = [
        normalizeConfigInstanceDraft({
            enabled: true,
            name: "demo-local",
            provider: "local",
        }),
        normalizeConfigInstanceDraft({
            enabled: false,
            name: "demo-disabled",
            provider: "local",
        }),
    ];
    const instances = new ControlInstances();
    t.after(async () => await instances.close());

    await instances.load(config);

    assert.equal(instances.registry.list().length, 1);
    assert.equal(instances.registry.get("demo-disabled"), undefined);
    const active = instances.registry.get("demo-local");
    assert.ok(active);
    assert.equal(active.supervision.snapshot().ready, false);
});

test("Worker metadata changes invalidate Instance lists without a new wire event kind", async (t) => {
    const config = createDefaultControlConfig();
    config.instances = [normalizeConfigInstanceDraft({
        enabled: true,
        name: "metadata-local",
        provider: "local",
    })];
    const instances = new ControlInstances();
    t.after(async () => await instances.close());
    await instances.load(config);
    const instance = instances.registry.get("metadata-local")!;
    const changes: string[] = [];
    instances.changes.onChange((change) => changes.push(change.kind));
    instance.supervision.state.metadataChanged();
    assert.deepEqual(changes, ["registry"]);
    await instances.registry.remove("metadata-local", instance);
    instance.supervision.state.metadataChanged();
    assert.deepEqual(changes, ["registry"],
        "retired generation must not invalidate a replacement's view");
});

test("ControlInstances closes only owned workers and preserves failed ownership for retry", async () => {
    const config = createDefaultControlConfig();
    config.instances = [
        normalizeConfigInstanceDraft({ name: "owned-ok", provider: "local" }),
        normalizeConfigInstanceDraft({ name: "owned-fail", provider: "local" }),
        normalizeConfigInstanceDraft({ name: "unowned", provider: "local" }),
    ];
    const instances = new ControlInstances();
    await instances.load(config);
    const ownedOk = instances.registry.get("owned-ok")!;
    const ownedFail = instances.registry.get("owned-fail")!;
    const stopped: string[] = [];
    let failStop = true;

    const patchStop = (name: string, instance: typeof ownedOk) => {
        instance.supervision.lifecycle.stop = async () => {
            stopped.push(name);
            if (name === "owned-fail" && failStop) throw new Error("stop failed");
            return instance.supervision.snapshot();
        };
    };
    patchStop("owned-ok", ownedOk);
    patchStop("owned-fail", ownedFail);
    patchStop("unowned", instances.registry.get("unowned")!);
    ownedOk.supervision.ownership.markOwned();
    ownedFail.supervision.ownership.markOwned();

    await assert.rejects(instances.close(), AggregateError);
    assert.deepEqual(stopped, ["owned-ok", "owned-fail"]);
    assert.equal(ownedOk.supervision.ownership.owned, false);
    assert.equal(ownedFail.supervision.ownership.owned, true);

    stopped.length = 0;
    failStop = false;
    await instances.close();
    assert.deepEqual(stopped, ["owned-fail"]);
    assert.equal(ownedFail.supervision.ownership.owned, false);
});

test("Instance removal publishes the committed snapshot before waiting for leases", async () => {
    const instance = createTestInstance(normalizeConfigInstanceDraft({
        name: "demo-registry",
        provider: "local",
    }));
    const registry = new InstanceRegistry([instance]);
    const changes = new InstanceChangeHub();
    const snapshots: Array<{ revision: number; names: string[] }> = [];
    changes.onChange(({ revision }) => snapshots.push({
        revision,
        names: registry.list().map((entry) => entry.config.name),
    }));

    const lease = instance.lifecycle.acquireLease();
    const retiring = registry.remove("demo-registry", instance, () => {
        changes.publish("registry");
    });

    assert.equal(registry.get("demo-registry"), undefined);
    assert.equal(changes.revision, 1);
    assert.deepEqual(snapshots, [{ revision: 1, names: [] }]);
    let completed = false;
    void retiring.then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false, "retirement must still drain the held lease");

    lease.release();
    assert.equal(await retiring, instance);
    assert.equal(completed, true);
    assert.equal(changes.revision, 1, "cleanup does not republish a committed removal");
    assert.equal(await registry.remove("demo-registry", instance, () => changes.publish("registry")), undefined);
    assert.equal(changes.revision, 1);
});
