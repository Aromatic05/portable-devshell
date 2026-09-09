import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionArtifactCapability } from "@portable-devshell/extension/artifact";

import { executeArtifactCommand } from "../../src/builtin/ArtifactCommand.ts";

function fakeCapability(calls: unknown[]): ExtensionArtifactCapability {
    return {
        async cancelTransfer(transferId) { calls.push(["cancel", transferId]); return { operation: "cancel", transfer: record(transferId) }; },
        async createShare(input) {
            calls.push(["share", input]);
            return {
                blake3: "b3", bytes: 1, downloadName: "x", expiresAtMs: 1, mediaType: "text/plain",
                shareId: "s1", source: input.source, state: "active", url: "http://example.invalid/s1"
            };
        },
        async getTransfer(transferId) { calls.push(["get", transferId]); return record(transferId); },
        async listShares() { return []; },
        async listTransfers() { return []; },
        async revokeShare(shareId) { return { revoked: true, shareId }; },
        async startTransfer(input) { calls.push(["transfer", input]); return { operation: "start", transfer: record("t1") }; },
        async waitForTransfer(transferId) { return record(transferId); }
    };
}

function record(transferId: string) {
    return {
        createdAt: "now",
        source: { handle: "h", instance: "one" } as const,
        status: "completed" as const,
        target: { instance: "two", path: "./x", workspace: "/two" },
        transferId,
        transferredBytes: 1,
        updatedAt: "now"
    };
}

test("Artifact command maps explicit CLI source/authority into the public capability", async () => {
    const calls: unknown[] = [];
    const result = await executeArtifactCommand(fakeCapability(calls), [
        "share", "one", "path:./x", "--workspace", "/one", "--authority", "two"
    ], new AbortController().signal);
    assert.equal(result.kind, "json");
    assert.deepEqual(calls, [["share", {
        authorityInstance: "two",
        source: { instance: "one", path: "./x", workspace: "/one" }
    }]]);
});

test("Artifact transfer normalizes relative target paths before invoking the public capability", async () => {
    const calls: unknown[] = [];
    await executeArtifactCommand(fakeCapability(calls), [
        "transfer", "one", "artifact:h", "two", "dest/file", "--target-workspace", "/two"
    ], new AbortController().signal);
    assert.deepEqual(calls, [["transfer", {
        authorityInstance: "one",
        source: { handle: "h", instance: "one" },
        target: { instance: "two", path: "./dest/file", workspace: "/two" }
    }]]);
});
