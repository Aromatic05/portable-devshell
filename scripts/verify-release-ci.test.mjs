import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateDevelopmentCiRuns } from "./verify-release-ci.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sha = "a".repeat(40);

function run(path, overrides = {}) {
    return {
        conclusion: "success",
        created_at: "2026-07-17T00:00:00Z",
        event: "push",
        head_branch: "dev0.4.5-1",
        head_sha: sha,
        html_url: `https://example.test/${path}`,
        path,
        status: "completed",
        ...overrides
    };
}

test("release CI gate accepts a successful target-matrix dev-tag run for the exact commit", () => {
    const result = evaluateDevelopmentCiRuns([
        run(".github/workflows/ci.yml")
    ], sha);

    assert.equal(result.ok, true);
    assert.equal(result.workflows.every((workflow) => workflow.successful !== undefined), true);
});

test("release CI gate rejects failures, release-tag runs, and runs for another commit", () => {
    const result = evaluateDevelopmentCiRuns([
        run(".github/workflows/ci.yml", { conclusion: "failure" }),
        run(".github/workflows/ci.yml", { head_branch: "v0.4.5" }),
        run(".github/workflows/ci.yml", { head_sha: "b".repeat(40) })
    ], sha);

    assert.equal(result.ok, false);
    assert.equal(result.workflows[0].successful, undefined);
    assert.equal(result.workflows[0].candidates.length, 1);
});

test("development CI validates every native target and exercises its target-specific package", async () => {
    const workflow = await readFile(resolve(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
    const installIndex = workflow.indexOf("pnpm install --frozen-lockfile");
    const scriptTestIndex = workflow.indexOf("node --test ./scripts/*.test.mjs");
    assert.ok(installIndex >= 0 && scriptTestIndex > installIndex);
    for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64"]) {
        assert.match(workflow, new RegExp(`target: ${target}`, "u"));
    }
    assert.match(workflow, /node \.\/scripts\/smoke-pty\.mjs/u);
    assert.match(workflow, /portable-devshell-app-\$\{\{ matrix\.target \}\}\.tar\.gz/u);
});

test("release workflow requires the development CI gate before packaging any release assets", async () => {
    const workflow = await readFile(resolve(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
    assert.match(workflow, /verify-development-ci:/u);
    assert.match(workflow, /node \.\/scripts\/verify-release-ci\.mjs/u);
    assert.match(workflow, /build-worker:\r?\n\s+needs: verify-development-ci/u);
    assert.match(workflow, /pnpm package:app -- --target "\$\{\{ matrix\.target \}\}"/u);
});
