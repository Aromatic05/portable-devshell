import assert from "node:assert/strict";
import test from "node:test";

import { InstanceChangeHub } from "../../../../src/instance/Change.ts";

test("instance change hub replays registry and config revisions", () => {
    const hub = new InstanceChangeHub({ replayLimit: 4 });
    const observed: Array<{ kind: string; revision: number }> = [];
    hub.onChange((change) => observed.push(change));

    hub.publish("registry");
    hub.publish("config");

    assert.equal(hub.revision, 2);
    assert.deepEqual(observed, [
        { kind: "registry", revision: 1 },
        { kind: "config", revision: 2 },
    ]);
    assert.deepEqual(hub.replay(1), {
        changes: observed,
        kind: "replay",
        lastRevision: 2,
    });
});

test("instance change hub reports a bounded replay gap", () => {
    const hub = new InstanceChangeHub({ replayLimit: 2 });
    hub.publish("registry");
    hub.publish("config");
    hub.publish("registry");

    assert.deepEqual(hub.replay(1), {
        gap: {
            lastRevision: 3,
            oldestAvailableRevision: 2,
            requestedFromRevision: 1,
        },
        kind: "gap",
    });
    const replay = hub.replay(2);
    assert.deepEqual(
        replay.kind === "replay"
            ? replay.changes.map((change) => change.revision)
            : [],
        [2, 3],
    );
});
