import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const globEntries = ["test/**/*.test.ts", "test/**/*.test.mjs"];
const globPattern = /"([^"]+\.test\.(?:ts|mjs))"/g;
const normalizedPath = (path) => path.replaceAll("\\", "/");

test("all regular Node package tests are included in their test scripts", () => {
    let packageCount = 0;
    for (const group of ["packages", "extensions"]) {
        for (const name of readdirSync(new URL(group + "/", root))) {
            const directory = new URL(group + "/" + name + "/", root);
            const packagePath = new URL("package.json", directory);
            if (!existsSync(packagePath)) continue;
            const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
            const command = manifest.scripts?.test ?? "";
            if (!command.includes("RunPackageTests.mjs")) continue;
            packageCount += 1;

            const cwd = fileURLToPath(directory);
            const patterns = [...command.matchAll(globPattern)].map((entry) => entry[1]);
            assert.ok(patterns.length > 0, group + "/" + name + ": test globs required");
            const selected = [...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd })))].map(normalizedPath).sort();
            const expected = [...new Set(globEntries.flatMap((pattern) => globSync(pattern, { cwd })))].map(normalizedPath).filter(
                (file) => !file.startsWith("test/stress/"),
            ).sort();
            assert.deepEqual(selected, expected, group + "/" + name + ": test discovery excludes regular tests");
        }
    }
    assert.ok(packageCount > 0, "expected Node test runner packages");
});

test("MCP App receipt stress test has an explicit, separate runner", () => {
    const directory = new URL("../packages/mcp/", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("package.json", directory), "utf8"));
    const command = manifest.scripts["test:stress"];
    assert.equal(typeof command, "string");
    const files = [...command.matchAll(globPattern)].flatMap((entry) =>
        globSync(entry[1], { cwd: fileURLToPath(directory) }).map(normalizedPath),
    );
    assert.deepEqual(files, ["test/stress/ActionStore.stress.test.ts"]);
    assert.doesNotMatch(manifest.scripts.test, /test\/stress\//u);
});
