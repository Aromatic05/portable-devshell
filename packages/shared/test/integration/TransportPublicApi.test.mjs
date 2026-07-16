import assert from "node:assert/strict";
import test from "node:test";

const shared = await import("@portable-devshell/shared");

test("shared does not expose a centralized control operation catalog", () => {
    assert.equal("controlOperations" in shared, false);
});

test("shared exposes three protocol layers and their shared compositions", () => {
    for (const name of [
        "Channel",
        "Codec",
        "PrefixRoute",
        "ClientConnection",
        "ControlLifecycleManager",
        "ControlSocketFile"
    ]) {
        assert.equal(typeof shared[name], "function", `${name} must be public`);
    }
    for (const name of ["FrameBuffer", "encodeFrame", "decodeFrame"]) {
        assert.equal(name in shared, false, `${name} must stay out of the root public API`);
    }
});
