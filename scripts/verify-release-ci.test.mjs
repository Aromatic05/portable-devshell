import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDevelopmentCiRuns } from "./verify-release-ci.mjs";

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
