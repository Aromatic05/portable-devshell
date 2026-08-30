import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceAppPresenceStore } from "@portable-devshell/mcp/testing";

test("Workspace App presence distinguishes bootstrap, live watch, handoff, and teardown", async () => {
    let now = 1_000;
    const presence = new WorkspaceAppPresenceStore({ now: () => now });

    presence.open("demo", "ctx-a");
    assert.equal(presence.has("demo", "ctx-a"), true);
    assert.equal(presence.isActive("demo", "ctx-a", 60_000), false);

    presence.touch("demo", "ctx-a");
    assert.equal(presence.isActive("demo", "ctx-a", 60_000), true);
    now += 5_001;
    assert.equal(presence.isActive("demo", "ctx-a", 60_000), false);

    presence.beginWatch("demo", "ctx-a");
    now += 30_000;
    assert.equal(presence.isActive("demo", "ctx-a", 60_000), true);

    presence.endWatch("demo", "ctx-a");
    assert.equal(presence.isActive("demo", "ctx-a", 60_000), true);
    now += 4_999;
    assert.equal(presence.isActive("demo", "ctx-a", 60_000), true);
    now += 2;
    assert.equal(presence.isActive("demo", "ctx-a", 60_000), false);

    const ready = presence.waitUntilActive("demo", "ctx-a", 60_000, 100);
    presence.beginWatch("demo", "ctx-a");
    assert.equal(await ready, true);

    presence.revokeContext("ctx-a");
    assert.equal(presence.has("demo", "ctx-a"), false);

    presence.open("demo", "ctx-b");
    presence.revokeInstance("demo");
    assert.equal(presence.has("demo", "ctx-b"), false);
});
