import assert from "node:assert/strict";
import test from "node:test";

import {
    createDefaultControlConfig,
    normalizeConfigInstanceDraft,
} from "@portable-devshell/shared";

import { ConfigChangeHub } from "../../../../src/config/change/Config.ts";
import { ControlInstances } from "../../../../src/instance/index.ts";

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

test("ControlInstances projects instance config changes into its change source", () => {
    const configChanges = new ConfigChangeHub();
    const instances = new ControlInstances({ configChanges });
    const kinds: string[] = [];
    const unsubscribe = instances.changes.onChange((change) => {
        kinds.push(change.kind);
    });

    configChanges.publish(["control.logLevel"]);
    configChanges.publish(["instances.0.env"]);

    assert.deepEqual(kinds, ["config"]);
    unsubscribe();
    instances.dispose();
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
