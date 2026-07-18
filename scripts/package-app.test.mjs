import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./package-app.mjs", import.meta.url));

test("application packaging rejects a target other than the native host", () => {
    const target = process.platform === "linux" && process.arch === "x64" ? "linux-arm64" : "linux-x64";
    const result = spawnSync(process.execPath, [script, "--target", target], {
        encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /install dependencies on the target platform first/u);
});
