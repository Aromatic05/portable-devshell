import assert from "node:assert/strict";
import test from "node:test";

const {
    artifactShareStates,
    artifactTransferStatuses,
    isArtifactTransferTerminal,
    recoverArtifactTransferStatus
} = await import("@portable-devshell/shared");

test("artifact transfer statuses expose the frozen asynchronous lifecycle", () => {
    assert.deepEqual(artifactTransferStatuses, [
        "queued",
        "preparing",
        "transferring",
        "verifying",
        "committing",
        "completed",
        "failed",
        "cancelling",
        "cancelled",
        "interrupted"
    ]);

    assert.equal(isArtifactTransferTerminal("completed"), true);
    assert.equal(isArtifactTransferTerminal("failed"), true);
    assert.equal(isArtifactTransferTerminal("cancelled"), true);
    assert.equal(isArtifactTransferTerminal("interrupted"), true);
    assert.equal(isArtifactTransferTerminal("queued"), false);
    assert.equal(isArtifactTransferTerminal("transferring"), false);
});

test("control restart preserves queued transfers and interrupts active transfers", () => {
    assert.equal(recoverArtifactTransferStatus("queued"), "queued");
    assert.equal(recoverArtifactTransferStatus("preparing"), "interrupted");
    assert.equal(recoverArtifactTransferStatus("transferring"), "interrupted");
    assert.equal(recoverArtifactTransferStatus("verifying"), "interrupted");
    assert.equal(recoverArtifactTransferStatus("committing"), "interrupted");
    assert.equal(recoverArtifactTransferStatus("cancelling"), "interrupted");
    assert.equal(recoverArtifactTransferStatus("completed"), "completed");
    assert.equal(recoverArtifactTransferStatus("failed"), "failed");
    assert.equal(recoverArtifactTransferStatus("cancelled"), "cancelled");
    assert.equal(recoverArtifactTransferStatus("interrupted"), "interrupted");
});

test("artifact shares have no download-count state", () => {
    assert.deepEqual(artifactShareStates, ["active", "expired", "revoked"]);
    assert.equal(artifactShareStates.includes("downloadLimitReached"), false);
});
