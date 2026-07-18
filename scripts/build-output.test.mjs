import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("package build scripts remove obsolete dist output before TypeScript emit", async () => {
    for (const packageName of ["shared", "core", "mcp", "control", "tui", "cli"]) {
        const manifest = JSON.parse(
            await readFile(resolve(repositoryRoot, "packages", packageName, "package.json"), "utf8")
        );
        const build = String(manifest.scripts?.build ?? "");
        assert.match(build, /rmSync\('dist',\{recursive:true,force:true\}\)/u, packageName);
        assert.match(build, /tsc -b --force/u, packageName);
    }
});

test("package test scripts execute tests without compiling first", async () => {
    for (const packageName of ["shared", "core", "mcp", "control", "tui", "cli"]) {
        const manifest = JSON.parse(
            await readFile(resolve(repositoryRoot, "packages", packageName, "package.json"), "utf8")
        );
        const command = String(manifest.scripts?.test ?? "");
        assert.doesNotMatch(command, /\b(build|tsc)\b/u, packageName);
        assert.match(command, /RunPackageTests\.mjs/u, packageName);
    }
});

test("TUI tests serialize files that exercise Ink global runtime state", async () => {
    const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "packages", "tui", "package.json"), "utf8"));
    assert.match(manifest.scripts.test, /--concurrency 1/u);
});


test("source test launchers pass filesystem loaders to Node as file URLs", async () => {
    for (const relativePath of [
        "test/RunPackageTests.mjs",
        "acceptance/AcceptanceSupport.mjs",
        "packages/control/test/integration/ControlRealWorker.test.ts"
    ]) {
        const source = await readFile(resolve(repositoryRoot, relativePath), "utf8");
        assert.match(source, /pathToFileURL/u, relativePath);
        assert.doesNotMatch(source, /"--import",\s*(?:sourceLoader|registerPath|resolve\(cwd, options\.loader\))/u, relativePath);
    }
});

test("Windows pnpm launchers avoid spawning pnpm.cmd directly", async () => {
    const packageSource = await readFile(resolve(repositoryRoot, "scripts/package-app.mjs"), "utf8");
    assert.match(packageSource, /resolvePnpmCommand/u);
    assert.doesNotMatch(packageSource, /pnpm\.cmd|ComSpec/u);

    const installSource = await readFile(resolve(repositoryRoot, "scripts/install-local.mjs"), "utf8");
    assert.match(installSource, /process\.env\.ComSpec \?\? "cmd\.exe"/u);
    assert.doesNotMatch(installSource, /pnpm\.cmd/u);
});
