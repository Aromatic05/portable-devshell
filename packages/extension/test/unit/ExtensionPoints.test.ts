import assert from "node:assert/strict";
import test from "node:test";

import { defineExtensionPoint } from "../../src/index.ts";
import { commands } from "../../src/cli.ts";
import { applications } from "../../src/web.ts";

test("domain Extension Point descriptors use stable string identity", () => {
    assert.equal(commands.id, "cli.commands");
    assert.equal(applications.id, "web.applications");
    assert.notEqual(commands, defineExtensionPoint("cli.commands"));
    assert.equal(defineExtensionPoint("cli.commands").id, commands.id);
});
