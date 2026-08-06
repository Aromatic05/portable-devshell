import assert from "node:assert/strict";
import test from "node:test";

const shared = await import("@portable-devshell/shared");

test("shared does not expose a centralized control operation catalog", () => {
    assert.equal("controlOperations" in shared, false);
});

test("shared exposes unified transport implementations and compositions", () => {
    for (const name of [
        "Codec",
        "PrefixRoute",
        "ClientConnection",
        "SocketChannel",
        "WebSocketChannel",
        "ControlLifecycleManager",
        "ControlSocketFile"
    ]) {
        assert.equal(typeof shared[name], "function", `${name} must be public`);
    }
    for (const name of [
        "Channel",
        "FrameBuffer",
        "encodeFrame",
        "decodeFrame"
    ]) {
        assert.equal(name in shared, false, `${name} must stay type-only or outside the root public API`);
    }
});
