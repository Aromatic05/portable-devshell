import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { AgentProviderRuntimePaths } from "../../src/builtin/provider/AgentProviderRuntimePaths.ts";

test("Agent provider runtime separates versioned provider code from stable installation and state", () => {
    const rootDirectory = join("/", "extension-state", "agent");
    const paths = new AgentProviderRuntimePaths({
        provider: "pi",
        rootDirectory,
        version: "1.2.3",
    });

    assert.equal(paths.agentDirectory, rootDirectory);
    assert.equal(paths.providerDirectory, join(rootDirectory, "providers", "pi"));
    assert.equal(
        paths.prefixDirectory,
        join(rootDirectory, "providers", "pi", "prefix", "1.2.3"),
    );
    assert.equal(
        paths.installationDirectory,
        join(rootDirectory, "providers", "pi", "install"),
    );
    assert.equal(
        paths.stateDirectory,
        join(rootDirectory, "providers", "pi", "state"),
    );
    assert.equal(
        paths.cacheDirectory,
        join(rootDirectory, "providers", "pi", "cache"),
    );

    const upgraded = new AgentProviderRuntimePaths({
        provider: "pi",
        rootDirectory,
        version: "1.2.4",
    });
    assert.notEqual(upgraded.prefixDirectory, paths.prefixDirectory);
    assert.equal(upgraded.installationDirectory, paths.installationDirectory);
    assert.equal(upgraded.stateDirectory, paths.stateDirectory);
});

test("Agent provider path segments cannot escape the managed prefix", () => {
    const rootDirectory = join("/", "state");
    assert.throws(
        () =>
            new AgentProviderRuntimePaths({
                provider: "../pi",
                rootDirectory,
                version: "1",
            }),
        TypeError,
    );
    assert.throws(
        () =>
            new AgentProviderRuntimePaths({
                provider: "pi",
                rootDirectory,
                version: "../1",
            }),
        TypeError,
    );
});
