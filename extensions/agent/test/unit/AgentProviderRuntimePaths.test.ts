import assert from "node:assert/strict";
import test from "node:test";

import { AgentProviderRuntimePaths } from "../../src/builtin/provider/AgentProviderRuntimePaths.ts";

test("Agent provider runtime uses a private versioned prefix and stable state directory", () => {
    const paths = new AgentProviderRuntimePaths({
        provider: "pi",
        rootDirectory: "/extension-state/agent",
        version: "1.2.3"
    });

    assert.equal(paths.agentDirectory, "/extension-state/agent");
    assert.equal(paths.providerDirectory, "/extension-state/agent/providers/pi");
    assert.equal(paths.prefixDirectory, "/extension-state/agent/providers/pi/prefix/1.2.3");
    assert.equal(paths.stateDirectory, "/extension-state/agent/providers/pi/state");
    assert.equal(paths.cacheDirectory, "/extension-state/agent/providers/pi/cache");
});

test("Agent provider path segments cannot escape the managed prefix", () => {
    assert.throws(
        () => new AgentProviderRuntimePaths({ provider: "../pi", rootDirectory: "/state", version: "1" }),
        TypeError
    );
    assert.throws(
        () => new AgentProviderRuntimePaths({ provider: "pi", rootDirectory: "/state", version: "../1" }),
        TypeError
    );
});
