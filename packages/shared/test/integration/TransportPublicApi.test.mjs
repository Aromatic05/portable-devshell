import assert from "node:assert/strict";
import test from "node:test";

const shared = await import("@portable-devshell/shared");

test("shared does not expose a centralized control operation catalog", () => {
    assert.equal("controlOperations" in shared, false);
});

test("shared publicly exposes only the three main socket communication layers", () => {
    assert.deepEqual(
        ["Channel", "Codec", "PrefixRoute"].filter((name) => typeof shared[name] === "function"),
        ["Channel", "Codec", "PrefixRoute"]
    );
});
