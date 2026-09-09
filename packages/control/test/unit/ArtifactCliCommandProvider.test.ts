import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type { CliCommandInvocationContext } from "@portable-devshell/extension/cli";
import type {
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactTransferStartInput
} from "@portable-devshell/shared";

import {
    createArtifactCliCommandProvider,
    executeArtifactCommand
} from "../../src/control/artifact/cli/ArtifactCliCommandProvider.ts";

function createArtifactPortStub() {
    const calls: Array<{ input?: unknown; method: string }> = [];
    return {
        calls,
        async cancelTransfer(transferId: string) {
            calls.push({ input: transferId, method: "cancel" });
            return { operation: "cancel" as const, transfer: transferRecord(transferId, "cancelled") };
        },
        async createShare(input: ArtifactShareInput, defaultInstance: string) {
            calls.push({ input: { defaultInstance, input }, method: "share" });
            return {
                blake3: "a".repeat(64),
                bytes: 1,
                downloadName: "dist.tar.zst",
                expiresAtMs: Date.now() + 60_000,
                mediaType: "application/zstd",
                shareId: "share-1",
                source: { instance: input.instance ?? defaultInstance, path: "./dist", type: "directory" as const },
                state: "active" as const,
                url: "https://example.test/artifacts/share/token"
            };
        },
        getTransfer(transferId: string) {
            calls.push({ input: transferId, method: "status" });
            return transferRecord(transferId, "transferring");
        },
        listShares(): ArtifactShareResult[] {
            calls.push({ method: "shares" });
            return [];
        },
        listTransfers() {
            calls.push({ method: "transfers" });
            return [];
        },
        async revokeShare(shareId: string) {
            calls.push({ input: shareId, method: "revoke" });
            return { revoked: true as const, shareId };
        },
        async startTransfer(input: ArtifactTransferStartInput, defaultInstance: string) {
            calls.push({ input: { defaultInstance, input }, method: "transfer" });
            return { operation: "start" as const, transfer: transferRecord("transfer-1", "queued") };
        }
    };
}

function transferRecord(transferId: string, status: "cancelled" | "queued" | "transferring") {
    return {
        createdAt: "2026-07-13T00:00:00.000Z",
        source: { instance: "source-a", path: "./dist", type: "directory" as const },
        status,
        target: { instance: "target-b", path: "/srv/app" },
        transferId,
        transferredBytes: 0,
        updatedAt: "2026-07-13T00:00:00.000Z"
    };
}

function invocation(): CliCommandInvocationContext {
    return {
        localOwner: true,
        requestId: "req-artifact",
        signal: new AbortController().signal,
        workingDirectory: "/repo"
    };
}

function requireJson(result: { kind: "json"; value: ExtensionJsonValue } | { kind: "text"; text: string }): ExtensionJsonValue {
    assert.equal(result.kind, "json");
    return result.value;
}

test("Artifact command is a Control-resident cli.commands Extension provider", async () => {
    const provider = createArtifactCliCommandProvider(createArtifactPortStub());

    assert.equal(provider.extensionId, "artifact");
    assert.deepEqual(provider.declaration, {
        id: "artifact",
        summary: "Manage artifact shares and transfers",
        title: "Artifact",
        usage: "artifact <command>"
    });
    const help = await provider.binding(["--help"], invocation());
    assert.equal(help.kind, "text");
    assert.match(help.text, /devshell artifact transfer/u);
});

test("artifact share preserves source authority and options through the internal domain port", async () => {
    const port = createArtifactPortStub();
    const value = requireJson(await executeArtifactCommand([
        "share", "source-a", "path:./dist", "--workspace", "/source",
        "--expires-in", "600", "--max-downloads", "3"
    ], port, invocation()));

    assert.deepEqual(port.calls, [{
        input: {
            defaultInstance: "source-a",
            input: {
                expiresInSeconds: 600,
                instance: "source-a",
                maxDownloads: 3,
                path: "./dist",
                workspace: "/source"
            }
        },
        method: "share"
    }]);
    assert.equal(typeof value, "object");
    assert.equal(Array.isArray(value), false);
    assert.equal((value as Record<string, ExtensionJsonValue>).shareId, "share-1");
    assert.match(String((value as Record<string, ExtensionJsonValue>).url), /artifacts\/share\/token/u);
});

test("artifact shares redacts bearer URLs while retaining metadata", async () => {
    const port = createArtifactPortStub();
    port.listShares = () => [{
        blake3: "a".repeat(64),
        bytes: 1,
        downloadName: "dist.tar.zst",
        expiresAtMs: Date.now() + 60_000,
        mediaType: "application/zstd",
        shareId: "share-list-1",
        source: { instance: "source-a", path: "./dist", type: "directory" as const },
        state: "active" as const,
        url: "https://example.test/artifacts/share/secret-bearer-token"
    }];

    const value = requireJson(await executeArtifactCommand(["shares"], port, invocation()));
    assert.ok(Array.isArray(value));
    const first = value[0];
    assert.equal(typeof first, "object");
    assert.equal(Array.isArray(first), false);
    assert.equal((first as Record<string, ExtensionJsonValue>).shareId, "share-list-1");
    assert.equal((first as Record<string, ExtensionJsonValue>).url, "[redacted]");
});

test("artifact transfer infers authority and normalizes a bare target path", async () => {
    const port = createArtifactPortStub();
    await executeArtifactCommand([
        "transfer", "host", "path:~/Download/input.bin", "target-b", "copy.bin",
        "--source-workspace", "/source", "--target-workspace", "/target"
    ], port, invocation());

    assert.deepEqual(port.calls, [{
        input: {
            defaultInstance: "target-b",
            input: {
                instance: "host",
                operation: "start",
                overwrite: false,
                sourcePath: "~/Download/input.bin",
                sourceWorkspace: "/source",
                targetInstance: "target-b",
                targetPath: "./copy.bin",
                targetWorkspace: "/target"
            }
        },
        method: "transfer"
    }]);
});

test("artifact status cancel list and revoke dispatch through the domain port", async () => {
    const port = createArtifactPortStub();
    for (const args of [
        ["transfer", "status", "transfer-1"],
        ["transfer", "cancel", "transfer-1"],
        ["transfers"],
        ["shares"],
        ["revoke", "share-1"]
    ]) {
        await executeArtifactCommand(args, port, invocation());
    }
    assert.deepEqual(port.calls.map((call) => call.method), ["status", "cancel", "transfers", "shares", "revoke"]);
});

test("artifact invalid input remains cli.usage before touching the domain port", async () => {
    const port = createArtifactPortStub();
    await assert.rejects(
        async () => await executeArtifactCommand(["share", "source-a", "./dist"], port, invocation()),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "cli.usage"
    );
    assert.equal(port.calls.length, 0);
});
