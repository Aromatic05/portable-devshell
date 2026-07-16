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

test("release CI gate accepts successful Linux and Windows dev-tag runs for the exact commit", () => {
    const result = evaluateDevelopmentCiRuns([
        run(".github/workflows/ci.yml"),
        run(".github/workflows/windows.yml")
    ], sha);

    assert.equal(result.ok, true);
    assert.equal(result.workflows.every((workflow) => workflow.successful !== undefined), true);
});

test("release CI gate rejects failures, release-tag runs, and runs for another commit", () => {
    const result = evaluateDevelopmentCiRuns([
        run(".github/workflows/ci.yml", { conclusion: "failure" }),
        run(".github/workflows/windows.yml", { head_branch: "v0.4.5" }),
        run(".github/workflows/windows.yml", { head_sha: "b".repeat(40) })
    ], sha);

    assert.equal(result.ok, false);
    assert.equal(result.workflows[0].successful, undefined);
    assert.equal(result.workflows[1].candidates.length, 0);
});

test("development CI installs dependencies before script tests and exercises the release installer", async () => {
    const workflow = await readFile(resolve(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
    const installIndex = workflow.indexOf("pnpm install --frozen-lockfile");
    const scriptTestIndex = workflow.indexOf("node --test ./scripts/*.test.mjs");
    assert.ok(installIndex >= 0 && scriptTestIndex > installIndex);
    assert.match(workflow, /pnpm smoke:install-release -- \.\/ci-artifacts\/portable-devshell-app\.tar\.gz/u);
});

test("release workflow requires the development CI gate before packaging any release assets", async () => {
    const workflow = await readFile(resolve(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
    assert.match(workflow, /verify-development-ci:/u);
    assert.match(workflow, /node \.\/scripts\/verify-release-ci\.mjs/u);
    assert.match(workflow, /build-worker:\r?\n\s+needs: verify-development-ci/u);
    assert.match(workflow, /package-app:\r?\n\s+needs: verify-development-ci/u);
});
