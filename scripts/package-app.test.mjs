import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./package-app.mjs", import.meta.url));

test("application packaging rejects a target other than the native host", () => {
    const host = `${process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
    const target = host === "linux-x64" ? "linux-arm64" : "linux-x64";
    const result = spawnSync(process.execPath, [script, "--target", target], {
        encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.equal(result.stderr.includes(target), true);
    assert.equal(result.stderr.includes(host), true);
});
