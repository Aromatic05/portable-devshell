import assert from "node:assert/strict";
import test from "node:test";

import { defineExtensionPoint } from "../../src/index.ts";
import * as cliApi from "../../src/domain/cli.ts";
import { commands } from "../../src/domain/cli.ts";
import * as webApi from "../../src/domain/web.ts";
import { applications } from "../../src/domain/web.ts";

test("domain Extension Point descriptors use stable string identity", () => {
    assert.equal(commands.id, "cli.commands");
    assert.equal(applications.id, "web.applications");
    assert.notEqual(commands, defineExtensionPoint("cli.commands"));
    assert.equal(defineExtensionPoint("cli.commands").id, commands.id);
});

test("domain leaf runtime exports contain only author-facing point descriptors", () => {
    assert.deepEqual(Object.keys(cliApi), ["commands"]);
    assert.deepEqual(Object.keys(webApi), ["applications"]);
});
