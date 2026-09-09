import assert from "node:assert/strict";
import test from "node:test";

import { defineExtensionPoint } from "../../src/index.ts";
import * as cliApi from "../../src/domain/cli.ts";
import { modelCommands, nativeCommands } from "../../src/domain/cli.ts";
import * as webApi from "../../src/domain/web.ts";
import { applications } from "../../src/domain/web.ts";

test("domain Extension Point descriptors use stable string identity", () => {
    assert.equal(nativeCommands.id, "cli.native-commands");
    assert.equal(modelCommands.id, "cli.model-commands");
    assert.equal(applications.id, "web.applications");
    assert.notEqual(nativeCommands, defineExtensionPoint("cli.native-commands"));
    assert.equal(defineExtensionPoint("cli.native-commands").id, nativeCommands.id);
    assert.notEqual(nativeCommands, modelCommands);
});

test("domain leaf runtime exports contain only author-facing point descriptors", () => {
    assert.deepEqual(Object.keys(cliApi), ["modelCommands", "nativeCommands"]);
    assert.deepEqual(Object.keys(webApi), ["applications"]);
});
