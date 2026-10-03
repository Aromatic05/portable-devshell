import assert from "node:assert/strict";
import test from "node:test";

import { ConfigChangeHub } from "../../../../src/config/change/Config.ts";
import { createConfigRouteModule } from "../../../../src/config/route/Config.ts";

test("config route keeps legacy get while snapshot carries revision", async () => {
    const view = { restartControlRequired: false };
    const changes = new ConfigChangeHub();
    changes.publish(["control.logLevel"]);
    const module = createConfigRouteModule(
        {
            getConfigView: () => view as never,
        } as never,
        changes,
    );
    const get = module.operations.find((entry) => entry.name === "get");
    const snapshot = module.operations.find(
        (entry) => entry.name === "snapshot",
    );
    if (get === undefined || snapshot === undefined)
        throw new Error("config read routes are missing");

    assert.deepEqual(
        await get.handle({ id: "get", name: "get" }, {} as never),
        view,
    );
    assert.deepEqual(
        await snapshot.handle(
            { id: "snapshot", name: "snapshot" },
            {} as never,
        ),
        { revision: 1, view },
    );
});
