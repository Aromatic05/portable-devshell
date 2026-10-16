import assert from "node:assert/strict";
import test from "node:test";

import { modelCommandAuthorized } from
    "../../../../src/extension/api/point/cli/command/Broker.ts";

const historicalDefault = ["artifact", "instance", "mcp", "secret", "skill"];
const memory = { extensionId: "comment", id: "memory" };
const unrelated = { extensionId: "comment", id: "mail" };

test("historical generated Model-command default grants only Memory compatibility", () => {
    assert.equal(modelCommandAuthorized(historicalDefault, memory), true);
    assert.equal(modelCommandAuthorized(historicalDefault, unrelated), false);
    assert.equal(modelCommandAuthorized(historicalDefault,
        { extensionId: "secret", id: "secret" }), true);
    assert.deepEqual(historicalDefault,
        ["artifact", "instance", "mcp", "secret", "skill"],
        "compatibility cannot mutate persisted instance configuration");
});

test("custom, disabled and reordered Model-command allowlists retain their explicit meaning", () => {
    for (const allowed of [
        [],
        ["artifact"],
        ["artifact", "instance", "mcp", "secret"],
        ["artifact", "mcp", "instance", "secret", "skill"],
        ["artifact", "instance", "mcp", "secret", "skill", "other"],
    ]) {
        assert.equal(modelCommandAuthorized(allowed, memory), false,
            `custom allowlist must not gain Memory: ${allowed.join(",")}`);
    }
    assert.equal(modelCommandAuthorized(["comment"], memory), true);
    assert.equal(modelCommandAuthorized(["comment"], unrelated), true);
});
