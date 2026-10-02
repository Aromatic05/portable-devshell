import assert from "node:assert/strict";
import test from "node:test";

import { InstanceChangeHub } from "../../../../src/control/instance/Change.ts";
import { createInstanceRouteModule } from "../../../../src/control/instance/Route.ts";
import { InstanceRegistry } from "../../../../src/control/instance/registry/Registry.ts";

test("instance route keeps legacy list while snapshot carries revision", async () => {
    const changes = new InstanceChangeHub();
    changes.publish("config");
    const module = createInstanceRouteModule({
        changes,
        configuredInstances: () => [],
        registry: new InstanceRegistry([]),
    });
    const list = module.operations.find((entry) => entry.name === "list");
    const snapshot = module.operations.find(
        (entry) => entry.name === "snapshot",
    );
    if (list === undefined || snapshot === undefined)
        throw new Error("instance read routes are missing");

    assert.deepEqual(
        await list.handle({ id: "list", name: "list" }, {} as never),
        [],
    );
    assert.deepEqual(
        await snapshot.handle(
            { id: "snapshot", name: "snapshot" },
            {} as never,
        ),
        { instances: [], revision: 1 },
    );
});
