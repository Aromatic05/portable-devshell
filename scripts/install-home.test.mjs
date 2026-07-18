import assert from "node:assert/strict";
import test from "node:test";

import { resolveInstallHome } from "./install-home.mjs";

test("install home follows Unix HOME precedence", () => {
    assert.equal(
        resolveInstallHome(
            { HOME: "/home/alice", USERPROFILE: "C:\\Users\\alice" },
            "linux",
            "/fallback"
        ),
        "/home/alice"
    );
});

test("install home follows Windows worker home precedence", () => {
    assert.equal(
        resolveInstallHome(
            { HOME: "C:\\msys64\\home\\alice", USERPROFILE: "C:\\Users\\alice" },
            "win32",
            "C:\\fallback"
        ),
        "C:\\Users\\alice"
    );
    assert.equal(
        resolveInstallHome(
            { HOMEDRIVE: "D:", HOMEPATH: "\\Users\\alice" },
            "win32",
            "C:\\fallback"
        ),
        "D:\\Users\\alice"
    );
});
