import assert from "node:assert/strict";
import test from "node:test";

import { modelCommandAuthorized } from
    "../../../../src/extension/api/point/cli/command/Broker.ts";

const historicalDefault = ["artifact", "instance", "mcp", "secret", "skill"];
const preRecallDefault = ["artifact", "comment", "instance", "mcp", "secret", "skill"];
const memory = { extensionId: "comment", id: "memory" };
const recall = { extensionId: "recall", id: "recall" };
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

test("historical generated model defaults make Recall available without changing saved ACLs", () => {
    for (const allowed of [historicalDefault, preRecallDefault]) {
        assert.equal(modelCommandAuthorized(allowed, recall), true);
        assert.equal(modelCommandAuthorized(allowed,
            { extensionId: "recall", id: "other" }), false);
    }
    assert.equal(modelCommandAuthorized(preRecallDefault, memory), true);
    assert.deepEqual(preRecallDefault,
        ["artifact", "comment", "instance", "mcp", "secret", "skill"],
        "compatibility must not mutate saved instance configuration");
    assert.equal(modelCommandAuthorized(
        ["artifact", "comment", "instance", "mcp", "recall", "secret", "skill"], recall), true);
});

test("custom, disabled and reordered Model-command allowlists retain their explicit meaning", () => {
    for (const allowed of [
        [],
        ["artifact"],
        ["artifact", "instance", "mcp", "secret"],
        ["artifact", "mcp", "instance", "secret", "skill"],
        ["artifact", "instance", "mcp", "secret", "skill", "other"],
        ["artifact", "comment", "instance", "mcp", "secret"],
        ["comment", "artifact", "instance", "mcp", "secret", "skill"],
    ]) {
        assert.equal(modelCommandAuthorized(allowed, memory), allowed.includes("comment"),
            `custom allowlist must preserve explicit Memory authorization: ${allowed.join(",")}`);
        assert.equal(modelCommandAuthorized(allowed, recall), false,
            `custom allowlist must not gain Recall: ${allowed.join(",")}`);
    }
    assert.equal(modelCommandAuthorized(["comment"], memory), true);
    assert.equal(modelCommandAuthorized(["comment"], unrelated), true);
});
