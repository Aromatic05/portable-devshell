import assert from "node:assert/strict";
import test from "node:test";

import type {
    ArtifactShareInput,
    ArtifactTransferStartInput
} from "@portable-devshell/shared";
import { CliMain } from "../../src/CliMain.ts";

function createBuffer(): { flush(): string; write(chunk: string): void } {
    const chunks: string[] = [];
    return {
        flush() {
            const value = chunks.join("");
            chunks.length = 0;
            return value;
        },
        write(chunk: string) {
            chunks.push(chunk);
        }
    };
}

function createCliClientArtifact() {
    const calls: Array<{ input?: unknown; method: string }> = [];
    return {
        calls,
        async cancelTransfer(transferId: string) {
            calls.push({ input: transferId, method: "cancel" });
            return { operation: "cancel" as const, transfer: transferRecord(transferId, "cancelled") };
        },
        async createShare(defaultInstance: string, input: ArtifactShareInput) {
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
        async getTransfer(transferId: string) {
            calls.push({ input: transferId, method: "status" });
            return transferRecord(transferId, "transferring");
        },
        async listShares() {
            calls.push({ method: "shares" });
            return [];
        },
        async listTransfers() {
            calls.push({ method: "transfers" });
            return [];
        },
        async revokeShare(shareId: string) {
            calls.push({ input: shareId, method: "revoke" });
            return { revoked: true as const, shareId };
        },
        async startTransfer(defaultInstance: string, input: ArtifactTransferStartInput) {
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

function cli(client: ReturnType<typeof createCliClientArtifact>) {
    const stdout = createBuffer();
    const stderr = createBuffer();
    return {
        instance: new CliMain({ createCliClients: () => ({ artifact: client } as never), stderr, stdout }),
        stderr,
        stdout
    };
}

test("artifact share uses the existing CLI control client", async () => {
    const client = createCliClientArtifact();
    const runtime = cli(client);
    assert.equal(
        await runtime.instance.run(["artifact", "share", "source-a", "path:./dist", "--expires-in", "600"]),
        0
    );
    assert.deepEqual(client.calls, [
        {
            input: {
                defaultInstance: "source-a",
                input: { expiresInSeconds: 600, instance: "source-a", path: "./dist" }
            },
            method: "share"
        }
    ]);
    assert.match(runtime.stdout.flush(), /"shareId": "share-1"/u);
    assert.equal(runtime.stderr.flush(), "");
});

test("artifact transfer returns queued and infers authority for a host source", async () => {
    const client = createCliClientArtifact();
    const runtime = cli(client);
    assert.equal(
        await runtime.instance.run([
            "artifact",
            "transfer",
            "host",
            "path:~/Download/input.bin",
            "target-b",
            "/tmp/input.bin"
        ]),
        0
    );
    assert.deepEqual(client.calls, [
        {
            input: {
                defaultInstance: "target-b",
                input: {
                    instance: "host",
                    operation: "start",
                    overwrite: false,
                    sourcePath: "~/Download/input.bin",
                    targetInstance: "target-b",
                    targetPath: "/tmp/input.bin"
                }
            },
            method: "transfer"
        }
    ]);
    assert.match(runtime.stdout.flush(), /"status": "queued"/u);
});

test("artifact status cancel list and revoke use typed control methods", async () => {
    const client = createCliClientArtifact();
    const runtime = cli(client);
    for (const args of [
        ["artifact", "transfer", "status", "transfer-1"],
        ["artifact", "transfer", "cancel", "transfer-1"],
        ["artifact", "transfers"],
        ["artifact", "shares"],
        ["artifact", "revoke", "share-1"]
    ]) {
        assert.equal(await runtime.instance.run(args), 0);
    }
    assert.deepEqual(client.calls.map((call) => call.method), ["status", "cancel", "transfers", "shares", "revoke"]);
});

test("artifact help hides host and invalid input follows common usage exit mapping", async () => {
    const client = createCliClientArtifact();
    const runtime = cli(client);
    assert.equal(await runtime.instance.run(["artifact", "help"]), 0);
    assert.doesNotMatch(runtime.stdout.flush(), /\bhost\b/u);

    assert.equal(await runtime.instance.run(["artifact", "share", "source-a", "./dist"]), 2);
    assert.equal(client.calls.length, 0);
    assert.match(runtime.stderr.flush(), /artifact:<handle> or path:<path>/u);
});
