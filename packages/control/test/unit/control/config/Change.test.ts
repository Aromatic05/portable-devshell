import assert from "node:assert/strict";
import test from "node:test";

import { ConfigChangeHub } from "../../../../src/config/change/Config.ts";

test("config change hub revisions, de-duplicates, and replays committed paths", () => {
    const hub = new ConfigChangeHub({ historyLimit: 4 });
    const observed: Array<{ paths: readonly string[]; revision: number }> = [];
    hub.onChange((change) => observed.push(change));

    assert.equal(hub.revision, 0);
    assert.equal(hub.publish([]), 0);
    assert.equal(hub.publish(["web.port", "control.logLevel", "web.port"]), 1);
    assert.equal(hub.publish(["instances.demo.enabled"]), 2);

    assert.deepEqual(observed, [
        {
            paths: ["control.logLevel", "web.port"],
            revision: 1,
        },
        {
            paths: ["instances.demo.enabled"],
            revision: 2,
        },
    ]);
    assert.deepEqual(hub.readSince(1), {
        changes: observed,
        kind: "events",
        latestRevision: 2,
        oldestAvailableRevision: 1,
    });
});

test("config change hub reports a gap after bounded history is trimmed", () => {
    const hub = new ConfigChangeHub({ historyLimit: 2 });
    hub.publish(["control.a"]);
    hub.publish(["control.b"]);
    hub.publish(["control.c"]);

    assert.deepEqual(hub.readSince(1), {
        changes: [],
        kind: "gap",
        latestRevision: 3,
        oldestAvailableRevision: 2,
    });
    assert.deepEqual(
        hub.readSince(2).changes.map((change) => change.revision),
        [2, 3],
    );
});
