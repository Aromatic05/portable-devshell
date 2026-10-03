import assert from "node:assert/strict";
import test from "node:test";

import {
    EXTENSION_CAPABILITY_IDS,
    type ExtensionCapabilities,
    type ExtensionCapability,
} from "@portable-devshell/extension";

import {
    EXTENSION_CAPABILITY_CONTEXT_KEYS,
    projectExtensionCapabilities,
    type ExtensionCapabilityRuntimeFactories,
} from "../../../../../src/control/extension/generation/capability/Projection.ts";

function factories(calls: string[]): ExtensionCapabilityRuntimeFactories {
    return Object.fromEntries(
        Object.values(EXTENSION_CAPABILITY_CONTEXT_KEYS).map((key) => [
            key,
            () => {
                calls.push(key);
                return { key } as never;
            },
        ]),
    ) as ExtensionCapabilityRuntimeFactories;
}

test("Extension capability projection maps every canonical grant to one runtime field", () => {
    const uncovered: Record<
        Exclude<
            keyof ExtensionCapabilities,
            (typeof EXTENSION_CAPABILITY_CONTEXT_KEYS)[ExtensionCapability]
        >,
        never
    > = {};
    const calls: string[] = [];
    const projected = projectExtensionCapabilities(
        EXTENSION_CAPABILITY_IDS,
        factories(calls),
    );
    const runtimeKeys = Object.values(EXTENSION_CAPABILITY_CONTEXT_KEYS);

    assert.deepEqual(uncovered, {});
    assert.equal(new Set(runtimeKeys).size, EXTENSION_CAPABILITY_IDS.length);
    assert.deepEqual(Object.keys(projected).sort(), [...runtimeKeys].sort());
    assert.deepEqual(calls.sort(), [...runtimeKeys].sort());
});

test("Extension capability projection does not construct undeclared runtime authorities", () => {
    const calls: string[] = [];
    const projected = projectExtensionCapabilities(
        ["context.observe", "worker.delegate"],
        factories(calls),
    );

    assert.deepEqual(Object.keys(projected).sort(), [
        "contextObserve",
        "workerDelegate",
    ]);
    assert.deepEqual(calls.sort(), ["contextObserve", "workerDelegate"]);
});
