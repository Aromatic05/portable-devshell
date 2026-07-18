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

test("Windows pnpm launchers execute through cmd.exe instead of spawning pnpm.cmd directly", async () => {
    for (const relativePath of ["scripts/package-app.mjs", "scripts/install-local.mjs"]) {
        const source = await readFile(resolve(repositoryRoot, relativePath), "utf8");
        assert.match(source, /process\.env\.ComSpec \?\? "cmd\.exe"/u, relativePath);
        assert.doesNotMatch(source, /pnpm\.cmd/u, relativePath);
    }
});
