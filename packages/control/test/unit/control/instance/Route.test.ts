import assert from "node:assert/strict";
import test from "node:test";
import type { Instance } from "@portable-devshell/core";
import { asInstanceName, type InstanceListEntry } from "@portable-devshell/shared";

import { InstanceChangeHub } from "../../../../src/instance/Change.ts";
import { InstanceRegistry } from "../../../../src/instance/Registry.ts";
import { createInstanceConfigRouteModule } from "../../../../src/instance/Route.ts";

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

test("config instance route reports the live Worker state and home", async () => {
    const snapshot = {
        connectionState: "connected" as const,
        daemonState: "running" as const,
        lastSeq: 12,
        name: asInstanceName("reverse-demo"),
        ready: true,
        status: "ready" as const,
    };
    const runtime = {
        config: { mcpEnabled: true, name: "reverse-demo" },
        supervision: {
            handshake: { homeDirectory: "/home/worker" },
            snapshot: () => snapshot,
        },
    } as unknown as Instance;
    const module = createInstanceConfigRouteModule({
        changes: new InstanceChangeHub(),
        registry: new InstanceRegistry([runtime]),
    });
    const list = module.operations.find(({ name }) => name === "listInstances");
    if (list === undefined) throw new Error("instance list route is missing");
    const entries = (await list.handle(
        { id: "list", name: "listInstances" },
        {} as never,
    )) as unknown as InstanceListEntry[];
    assert.equal(entries[0]?.snapshot.status, "ready");
    assert.equal(entries[0]?.snapshot.connectionState, "connected");
    assert.equal(entries[0]?.homeDirectory, "/home/worker");
});
