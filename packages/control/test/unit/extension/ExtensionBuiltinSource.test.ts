import assert from "node:assert/strict";
import test from "node:test";

import {
    CONTROL_BUILTIN_EXTENSION_SOURCES_ENV,
    readBuiltinExtensionSources
} from "../../../src/control/extension/ExtensionBuiltinSource.ts";

test("builtin Extension source parser accepts only unique absolute paths", () => {
    const key = CONTROL_BUILTIN_EXTENSION_SOURCES_ENV;
    assert.deepEqual(readBuiltinExtensionSources({}), []);
    assert.deepEqual(readBuiltinExtensionSources({ [key]: "" }), []);
    assert.deepEqual(
        readBuiltinExtensionSources({ [key]: JSON.stringify(["/one", "/two", "/one"]) }),
        ["/one", "/two"]
    );
});

test("builtin Extension source parser rejects malformed or relative inputs", () => {
    const key = CONTROL_BUILTIN_EXTENSION_SOURCES_ENV;
    assert.throws(() => readBuiltinExtensionSources({ [key]: "{" }), /JSON array/u);
    assert.throws(
        () => readBuiltinExtensionSources({ [key]: JSON.stringify(["relative"]) }),
        /only absolute paths/u
    );
    assert.throws(
        () => readBuiltinExtensionSources({ [key]: JSON.stringify({ source: "/one" }) }),
        /only absolute paths/u
    );
});
