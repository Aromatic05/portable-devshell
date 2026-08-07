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
    const suiteIndex = workflow.indexOf("run-development-ci.mjs");
    assert.ok(installIndex >= 0 && suiteIndex > installIndex);
    for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64"]) {
        assert.match(workflow, new RegExp(`target: ${target}`, "u"));
    }
    const chromiumIndex = workflow.indexOf("playwright install --with-deps chromium");
    const browserEnvironmentIndex = workflow.indexOf("PORTABLE_DEVSHELL_CHROMIUM=$chromium_path");
    assert.ok(chromiumIndex > installIndex && browserEnvironmentIndex > chromiumIndex);
    assert.ok(suiteIndex > browserEnvironmentIndex);
    assert.match(workflow, /if: always\(\)/u);
    const suite = await readFile(resolve(repositoryRoot, "scripts", "run-development-ci.mjs"), "utf8");
    assert.match(suite, /smoke-pty\.mjs/u);
    assert.match(suite, /portable-devshell-app-\$\{target\}\.tar\.gz/u);
    assert.match(suite, /smoke-install-release-windows\.mjs/u);
    assert.match(suite, /acceptance\/run-final-acceptance\.sh/u);
    const finalAcceptance = await readFile(resolve(repositoryRoot, "acceptance", "run-final-acceptance.mjs"), "utf8");
    assert.match(finalAcceptance, /acceptance\/run-web-browser-smoke\.mjs/u);
});

test("release workflow requires the development CI gate before packaging any release assets", async () => {
    const workflow = await readFile(resolve(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
    assert.match(workflow, /concurrency:\r?\n\s+group: release-\$\{\{ github\.ref \}\}\r?\n\s+cancel-in-progress: false/u);
    assert.match(workflow, /verify-development-ci:/u);
    assert.match(workflow, /version-state\.mjs check-release "\$GITHUB_REF_NAME"/u);
    assert.match(workflow, /publish-release\.mjs --check-absent --tag "\$GITHUB_REF_NAME" --repository "\$GITHUB_REPOSITORY"/u);
    assert.match(workflow, /node \.\/scripts\/verify-release-ci\.mjs/u);
    assert.match(workflow, /build-worker:\r?\n\s+needs: verify-development-ci/u);
    assert.match(workflow, /pnpm package:app -- --target "\$\{\{ matrix\.target \}\}"/u);
    assert.match(workflow, /smoke-worker\.mjs \.\/release-assets\/devshell-worker-\$\{\{ matrix\.target \}\}/u);
    assert.match(workflow, /smoke-reverse-worker\.mjs \.\/release-assets\/devshell-worker-\$\{\{ matrix\.target \}\}/u);
    assert.match(workflow, /smoke-client\.mjs \.\/release-assets\/devshell-worker-\$\{\{ matrix\.target \}\}/u);
    assert.match(workflow, /smoke:package -- \.\/release-assets\/portable-devshell-app-\$\{\{ matrix\.target \}\}\.tar\.gz/u);
    assert.match(workflow, /smoke:install-release -- \.\/release-assets\/portable-devshell-app-\$\{\{ matrix\.target \}\}\.tar\.gz/u);
    assert.match(workflow, /smoke-install-release-windows\.mjs \.\/release-assets\/portable-devshell-app-\$\{\{ matrix\.target \}\}\.tar\.gz/u);
    assert.match(workflow, /publish-release\.mjs --tag "\$GITHUB_REF_NAME" --asset-dir \.\/release-assets/u);
    assert.doesNotMatch(workflow, /gh release upload|--clobber/u);
});
