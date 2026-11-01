import assert from "node:assert/strict";
import test from "node:test";
import { createInstance } from "@portable-devshell/core";
import { normalizeConfigInstanceDraft, type InstanceListEnvelope } from "@portable-devshell/shared";

import { InstanceRegistry } from "../../../src/instance/Registry.ts";
import { InstanceChangeHub } from "../../../src/instance/Change.ts";
import { createInstanceConfigRouteModule } from "../../../src/instance/Route.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

test("catalog publishes native Instance creation identity across updates and same-name recreation", async () => {
    const home = await createTestTempDirectory("instance-incarnation");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const instances: ReturnType<typeof createInstance>[] = [];
    try {
        const config = normalizeConfigInstanceDraft({ name: "alpha", provider: "local", enabled: true });
        const original = createInstance(config);
        instances.push(original);
        const registry = new InstanceRegistry([original]);
        const changes = new InstanceChangeHub();
        const route = createInstanceConfigRouteModule({ registry, changes });
        const read = route.operations.find(({ name }) => name === "snapshotInstances")!.handle;
        const snapshot = async () => await read({} as never, {} as never) as unknown as InstanceListEnvelope;
        const identity = (await snapshot()).instances[0]!.incarnation;
        assert.equal(identity, original.incarnation);
        assert.match(identity!, /^[a-f0-9-]{36}$/);
        original.update({ ...config, env: { CHANGED: "yes" } });
        const workerSnapshot = original.supervision.snapshot();
        Object.assign(original.supervision, { snapshot: () => ({ ...workerSnapshot, pid: 222, lastSeq: 0 }) });
        assert.equal((await snapshot()).instances[0]!.incarnation, identity,
            "the descriptor identity is independent of mutable config and Worker snapshots");
        await registry.remove("alpha", original);
        await original.close();
        const replacement = createInstance(config);
        instances.push(replacement);
        registry.add(replacement);
        changes.publish("registry");
        assert.notEqual((await snapshot()).instances[0]!.incarnation, identity,
            "the final same-name catalog retains the creation boundary even without an intervening read");
    } finally {
        await Promise.all(instances.map(async (instance) => await instance.close()));
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
    }
});
