import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionArtifactCapability } from "@portable-devshell/extension/artifact";
import type { CliModelCommandInvocationContext } from "@portable-devshell/extension/cli";

import { executeArtifactModelCommand } from "../../src/builtin/ArtifactModelCommand.ts";

const invocation: CliModelCommandInvocationContext = {
    context: {
        async connectInstance() { throw new Error("unused"); }
    },
    instance: "instance-a",
    requestId: "request-1",
    signal: new AbortController().signal,
    workspace: "/repo/a"
};

function capability(calls: unknown[]): ExtensionArtifactCapability {
    return {
        async cancelTransfer(transferId) {
            calls.push(["cancel", transferId]);
            return { operation: "cancel", transfer: localTransfer(transferId) };
        },
        async createShare(input) {
            calls.push(["share", input]);
            return {
                blake3: "b3",
                bytes: 1,
                downloadName: "x",
                expiresAtMs: 1,
                mediaType: "text/plain",
                shareId: "share-local",
                source: input.source,
                state: "active",
                url: "http://example.invalid/share-local"
            };
        },
        async getTransfer(transferId) {
            return transferId === "cross" ? crossTransfer(transferId) : localTransfer(transferId);
        },
        async listShares() {
            return [
                share("share-local", "instance-a", "/repo/a"),
                share("share-other-workspace", "instance-a", "/repo/other"),
                share("share-other-instance", "instance-b", "/repo/b")
            ];
        },
        async listTransfers() { return [localTransfer("local"), crossTransfer("cross")]; },
        async revokeShare(shareId) {
            calls.push(["revoke", shareId]);
            return { revoked: true, shareId };
        },
        async startTransfer() { throw new Error("model must not start transfers"); },
        async waitForTransfer() { throw new Error("unused"); }
    };
}

test("Artifact model share pins authority, instance, and path Workspace to the current Context", async () => {
    const calls: unknown[] = [];
    await executeArtifactModelCommand(capability(calls), ["share", "path:./out.txt"], invocation);
    assert.deepEqual(calls, [["share", {
        authorityInstance: "instance-a",
        source: { instance: "instance-a", path: "./out.txt", workspace: "/repo/a" }
    }]]);
    await assert.rejects(
        executeArtifactModelCommand(capability(calls), ["share", "path:./out.txt", "--authority", "instance-b"], invocation),
        /Unknown option/u
    );
});

test("Artifact model list/revoke hides records outside the current Context", async () => {
    const calls: unknown[] = [];
    const listed = await executeArtifactModelCommand(capability(calls), ["shares"], invocation);
    assert.deepEqual(listed.kind === "json" ? listed.value : undefined, [{
        blake3: "b3",
        bytes: 1,
        downloadName: "x",
        expiresAtMs: 1,
        mediaType: "text/plain",
        shareId: "share-local",
        source: { instance: "instance-a", path: "./x", workspace: "/repo/a" },
        state: "active",
        url: "[redacted]"
    }]);
    await assert.rejects(
        executeArtifactModelCommand(capability(calls), ["revoke", "share-other-instance"], invocation),
        /unavailable in the current model Context/u
    );
    await executeArtifactModelCommand(capability(calls), ["revoke", "share-local"], invocation);
    assert.deepEqual(calls, [["revoke", "share-local"]]);
});

test("Artifact model transfer status/cancel only operate on current-Context records and cannot create transfers", async () => {
    const calls: unknown[] = [];
    const listed = await executeArtifactModelCommand(capability(calls), ["transfers"], invocation);
    assert.deepEqual(listed.kind === "json" ? listed.value : undefined, [localTransfer("local")]);
    await assert.rejects(
        executeArtifactModelCommand(capability(calls), ["transfer", "status", "cross"], invocation),
        /unavailable in the current model Context/u
    );
    await executeArtifactModelCommand(capability(calls), ["transfer", "cancel", "local"], invocation);
    assert.deepEqual(calls, [["cancel", "local"]]);
    await assert.rejects(
        executeArtifactModelCommand(capability(calls), ["transfer", "instance-a", "artifact:h", "instance-b", "./x"], invocation),
        /do not create cross-instance transfers/u
    );
});

function share(shareId: string, instance: string, workspace: string) {
    return {
        blake3: "b3",
        bytes: 1,
        downloadName: "x",
        expiresAtMs: 1,
        mediaType: "text/plain",
        shareId,
        source: { instance, path: "./x", workspace } as const,
        state: "active" as const,
        url: `http://example.invalid/${shareId}`
    };
}

function localTransfer(transferId: string) {
    return {
        createdAt: "now",
        source: { handle: "h", instance: "instance-a" } as const,
        status: "completed" as const,
        target: { instance: "instance-a", path: "./x", workspace: "/repo/a" },
        transferId,
        transferredBytes: 1,
        updatedAt: "now"
    };
}

function crossTransfer(transferId: string) {
    return {
        createdAt: "now",
        source: { handle: "h", instance: "instance-a" } as const,
        status: "completed" as const,
        target: { instance: "instance-b", path: "./x", workspace: "/repo/b" },
        transferId,
        transferredBytes: 1,
        updatedAt: "now"
    };
}
