import assert from "node:assert/strict";
import test from "node:test";

import { resolveApplicationSmokeArchive } from "./smoke-artifact-arguments.mjs";

test("application smoke defaults to the current host release asset", () => {
    assert.equal(
        resolveApplicationSmokeArchive([], "/repo", "linux", "x64"),
        "/repo/release-assets/portable-devshell-app-linux-x64.tar.gz",
    );
    assert.equal(
        resolveApplicationSmokeArchive(
            ["--", "./custom.tar.gz"],
            "/repo",
            "linux",
            "x64",
        ),
        "/repo/custom.tar.gz",
    );
    assert.throws(
        () =>
            resolveApplicationSmokeArchive(["a", "b"], "/repo", "linux", "x64"),
        /at most one/u,
    );
});
