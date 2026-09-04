import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const releaseWorkflowPath = fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url));

async function readReleaseWorkflow() {
    return await readFile(releaseWorkflowPath, "utf8");
}

test("release asset jobs install the frozen dependency graph before building", async () => {
    const workflow = await readReleaseWorkflow();
    const buildStart = workflow.indexOf("    build-worker:\n");
    const publishStart = workflow.indexOf("    publish:\n", buildStart);
    assert.ok(buildStart >= 0 && publishStart > buildStart, "release build-worker job must exist");
    const buildJob = workflow.slice(buildStart, publishStart);
    const install = buildJob.indexOf("pnpm install --frozen-lockfile");
    const build = buildJob.indexOf("pnpm build");
    assert.ok(install >= 0, "release build-worker must install dependencies from the frozen lockfile");
    assert.ok(build > install, "release build-worker must install dependencies before pnpm build");
});

test("release verifies the tagged commit belongs to the default branch before asset jobs", async () => {
    const workflow = await readReleaseWorkflow();
    const verifyStart = workflow.indexOf("    verify-development-ci:\n");
    const buildStart = workflow.indexOf("    build-worker:\n", verifyStart);
    assert.ok(verifyStart >= 0 && buildStart > verifyStart, "release verification job must precede asset jobs");
    const verifyJob = workflow.slice(verifyStart, buildStart);
    assert.match(verifyJob, /fetch-depth: 0/u);
    assert.match(
        verifyJob,
        /git merge-base --is-ancestor "\$GITHUB_SHA" "origin\/\$DEFAULT_BRANCH"/u,
    );
});

test("release automation writes a scoped conventional version bump commit", async () => {
    const workflow = await readReleaseWorkflow();
    assert.match(workflow, /git add package\.json crates\/devshell-worker\/Cargo\.toml Cargo\.lock scripts\/install-local\.test\.mjs/u);
    assert.match(
        workflow,
        /git commit -m "chore\(release\): bump version to \$next_version"/u,
    );
});
