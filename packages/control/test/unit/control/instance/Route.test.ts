import assert from "node:assert/strict";
import test from "node:test";

import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { createInstanceConfigRouteModule } from "../../../../src/instance/Route.ts";
import { InstanceRegistry } from "@portable-devshell/core";

test("config instance route exposes list and revisioned snapshot", async () => {
    const changes = new InstanceChangeHub();
    changes.publish("config");
    const module = createInstanceConfigRouteModule({
        changes,
        configuredInstances: () => [],
        registry: new InstanceRegistry([]),
    });
    const list = module.operations.find(
        (entry) => entry.name === "listInstances",
    );
    const snapshot = module.operations.find(
        (entry) => entry.name === "snapshotInstances",
    );
    if (list === undefined || snapshot === undefined)
        throw new Error("instance read routes are missing");

    assert.deepEqual(
        await list.handle({ id: "list", name: "listInstances" }, {} as never),
        [],
    );
    assert.deepEqual(
        await snapshot.handle(
            { id: "snapshot", name: "snapshotInstances" },
            {} as never,
        ),
        { instances: [], revision: 1 },
    );
});
