import assert from "node:assert/strict";
import test from "node:test";

import { AgentProviderRuntimePaths } from "../../src/runtime/AgentProviderRuntimePaths.ts";

test("Agent provider runtime uses a private versioned prefix and stable state directory", () => {
    const paths = new AgentProviderRuntimePaths({
        homeDirectory: "/home/tester",
        provider: "pi",
        version: "1.2.3"
    });

    assert.equal(paths.agentdDirectory, "/home/tester/.devshell/agentd");
    assert.equal(paths.providerDirectory, "/home/tester/.devshell/agentd/providers/pi");
    assert.equal(paths.prefixDirectory, "/home/tester/.devshell/agentd/providers/pi/prefix/1.2.3");
    assert.equal(paths.stateDirectory, "/home/tester/.devshell/agentd/providers/pi/state");
    assert.equal(paths.cacheDirectory, "/home/tester/.devshell/agentd/providers/pi/cache");
});

test("Agent provider path segments cannot escape the managed prefix", () => {
    assert.throws(
        () => new AgentProviderRuntimePaths({ homeDirectory: "/home/tester", provider: "../pi", version: "1" }),
        TypeError
    );
    assert.throws(
        () => new AgentProviderRuntimePaths({ homeDirectory: "/home/tester", provider: "pi", version: "../1" }),
        TypeError
    );
});
