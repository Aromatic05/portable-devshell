import assert from "node:assert/strict";
import test from "node:test";

import {
    CONTROL_BUILTIN_EXTENSION_SOURCES_ENV,
    readBuiltinExtensionSources
} from "../../../src/control/extension/ExtensionBuiltinSource.ts";

test("builtin Extension source parser accepts unique id-bound absolute paths", () => {
    const key = CONTROL_BUILTIN_EXTENSION_SOURCES_ENV;
    assert.deepEqual(readBuiltinExtensionSources({}), []);
    assert.deepEqual(readBuiltinExtensionSources({ [key]: "" }), []);
    assert.deepEqual(
        readBuiltinExtensionSources({
            [key]: JSON.stringify([
                { id: "skill", path: "/one" },
                { id: "agent", path: "/two" }
            ])
        }),
        [
            { id: "skill", path: "/one" },
            { id: "agent", path: "/two" }
        ]
    );
});

test("builtin Extension source parser rejects malformed, relative, or duplicate identities", () => {
    const key = CONTROL_BUILTIN_EXTENSION_SOURCES_ENV;
    assert.throws(() => readBuiltinExtensionSources({ [key]: "{" }), /JSON array/u);
    assert.throws(
        () => readBuiltinExtensionSources({ [key]: JSON.stringify([{ id: "skill", path: "relative" }]) }),
        /paths must be absolute/u
    );
    assert.throws(
        () => readBuiltinExtensionSources({ [key]: JSON.stringify([{ id: "Bad_ID", path: "/one" }]) }),
        /invalid Extension id/u
    );
    assert.throws(
        () => readBuiltinExtensionSources({
            [key]: JSON.stringify([
                { id: "skill", path: "/one" },
                { id: "skill", path: "/two" }
            ])
        }),
        /duplicate id skill/u
    );
    assert.throws(
        () => readBuiltinExtensionSources({ [key]: JSON.stringify({ id: "skill", path: "/one" }) }),
        /JSON array/u
    );
});
