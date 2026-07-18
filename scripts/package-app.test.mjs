import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
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


test("application packaging selects CLI by workspace directory", async () => {
    const source = await readFile(script, "utf8");
    assert.match(source, /--filter=\.\/packages\/cli/u);
    assert.doesNotMatch(source, /--filter["\s,]+@portable-devshell\/cli/u);
    assert.match(source, /"deploy",\s*"--legacy"/u);
});

test("application packaging forces pnpm legacy deploy for Windows-compatible workspace links", async () => {
    const source = await readFile(script, "utf8");
    assert.match(source, /"deploy",\s*"--legacy",/u);
});
