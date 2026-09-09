import assert from "node:assert/strict";
import test from "node:test";

import { defineExtensionPoint } from "../../src/index.ts";
import { commands, parseCliCommandDeclaration } from "../../src/cli.ts";
import { applications, parseWebApplicationDeclaration } from "../../src/web.ts";

test("domain Extension Point descriptors use stable string identity", () => {
    assert.equal(commands.id, "cli.commands");
    assert.equal(applications.id, "web.applications");
    assert.notEqual(commands, defineExtensionPoint("cli.commands"));
    assert.equal(defineExtensionPoint("cli.commands").id, commands.id);
});

test("domain declaration parsers keep point-specific schema out of core", () => {
    assert.deepEqual(parseCliCommandDeclaration({
        id: "agent",
        summary: "Run an Agent",
        title: "Agent",
        usage: "agent <command>"
    }), {
        id: "agent",
        summary: "Run an Agent",
        title: "Agent",
        usage: "agent <command>"
    });
    assert.deepEqual(parseWebApplicationDeclaration({ id: "agent", title: "Agent" }), {
        id: "agent",
        title: "Agent"
    });
    assert.throws(
        () => parseCliCommandDeclaration({ id: "agent", title: "Agent", transport: "rpc" }),
        /unknown field/u
    );
});
