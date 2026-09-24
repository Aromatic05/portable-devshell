import assert from "node:assert/strict";
import test from "node:test";

import {
    ConfigRegistry,
    ControlGlobalTomlDocument,
    createCoreConfigRegistry,
} from "../../../../src/testing.ts";

test("core Config registry owns the current global domains", () => {
    const registry = createCoreConfigRegistry();

    assert.deepEqual(
        registry.list().map((definition) => definition.id),
        ["control", "mcp", "web"],
    );
    assert.deepEqual(registry.require("mcp").owner, { kind: "core" });
});

test("Config registry rejects duplicate domain ownership", () => {
    const registry = createCoreConfigRegistry();

    assert.throws(
        () =>
            registry.register({
                id: "mcp",
                owner: {
                    extensionId: "example",
                    generation: "gen-a",
                    kind: "extension",
                },
            }),
        /already registered by core/u,
    );
});

test("global TOML domain admission follows the injected Config registry", () => {
    const registry = new ConfigRegistry([
        { id: "control", owner: { kind: "core" } },
        { id: "mcp", owner: { kind: "core" } },
    ]);
    const document = new ControlGlobalTomlDocument(registry);

    assert.throws(
        () =>
            document.decode({
                version: 2,
                web: { enabled: true },
            }),
        /web is not supported/u,
    );
});
