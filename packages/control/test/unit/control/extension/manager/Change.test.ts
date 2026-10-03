import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionChangeHub } from "../../../../../src/extension/manager/Change.ts";

test("extension change hub publishes sorted unique revisions and replays retained events", () => {
    const hub = new ExtensionChangeHub({ historyLimit: 2 });
    const observed: unknown[] = [];
    hub.onChange((change) => observed.push(change));

    assert.equal(hub.publish(["zeta", "alpha", "zeta"]), 1);
    assert.equal(hub.publish([]), 1);
    assert.equal(hub.publish(["beta"]), 2);
    assert.deepEqual(observed, [
        { extensionIds: ["alpha", "zeta"], revision: 1 },
        { extensionIds: ["beta"], revision: 2 },
    ]);
    assert.deepEqual(hub.readSince(1), {
        changes: observed,
        kind: "events",
        latestRevision: 2,
        oldestAvailableRevision: 1,
    });

    hub.publish(["gamma"]);
    assert.deepEqual(hub.readSince(1), {
        changes: [],
        kind: "gap",
        latestRevision: 3,
        oldestAvailableRevision: 2,
    });
    assert.deepEqual(hub.readSince(2).changes.map(({ revision }) => revision), [2, 3]);
});
