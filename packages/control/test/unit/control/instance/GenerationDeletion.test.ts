import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfigInstanceDraft } from "@portable-devshell/shared";
import { InstanceRegistry } from "../../../../src/instance/Registry.ts";
import { createTestInstance } from "../../../support/InstanceRuntime.ts";

for (const outcome of ["resolve", "reject"] as const) {
    test(`old generation drain ${outcome} cannot delete a same-name replacement or accept stale deletion`, async (t) => {
        const config = normalizeConfigInstanceDraft({ name: "same-name", provider: "local" });
        const old = createTestInstance(config);
        const replacement = createTestInstance(config);
        t.after(async () => { await replacement.retire(); });
        const registry = new InstanceRegistry([old]);
        let finish!: () => void;
        let fail!: (error: Error) => void;
        const drain = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
        t.mock.method(old, "retire", () => drain);
        let notifications = 0;
        const removed = registry.remove(config.name, old, () => { notifications++; });
        const checked = outcome === "reject" ? assert.rejects(removed, /injected old drain failure/) : removed;
        assert.equal(registry.get(config.name), undefined);
        registry.add(replacement);
        await assert.rejects(registry.remove(config.name, old, () => { notifications++; }), /stale instance generation/);
        assert.equal(registry.get(config.name), replacement);
        assert.equal(replacement.lifecycle.phase, "active");
        assert.equal(notifications, 1);
        if (outcome === "reject") fail(new Error("injected old drain failure"));
        else finish();
        await checked;
        assert.equal(registry.get(config.name), replacement);
        assert.deepEqual(registry.list(), [replacement]);
        assert.equal(notifications, 1);
    });
}

test("real leased retirement drains only the old generation after a same-name replacement becomes visible", async (t) => {
    const config = normalizeConfigInstanceDraft({ name: "leased-name", provider: "local" });
    const old = createTestInstance(config);
    const replacement = createTestInstance(config);
    const registry = new InstanceRegistry([old]);
    const lease = old.lifecycle.acquireLease();
    const replacementLease = replacement.lifecycle.acquireLease();
    t.after(async () => { lease.release(); replacementLease.release(); await old.retire(); await replacement.retire(); });
    const removed = registry.remove(config.name, old);
    assert.equal(old.lifecycle.phase, "retiring");
    assert.throws(() => old.lifecycle.acquireLease(), /retired/);
    registry.add(replacement);
    assert.equal(replacementLease.instance, replacement);
    await assert.rejects(registry.remove(config.name, old), /stale instance generation/);
    lease.release();
    assert.equal(await removed, old);
    assert.equal(old.lifecycle.phase, "retired");
    assert.equal(replacement.lifecycle.phase, "active");
    assert.equal(registry.get(config.name), replacement);
    replacementLease.release();
});
