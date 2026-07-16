import assert from "node:assert/strict";
import test from "node:test";

import type {
    ArtifactShareResult,
    ArtifactTransferRecord
} from "@portable-devshell/shared";
import { TuiAppStore } from "@portable-devshell/tui/testing";

test("artifact share replacement sorts newest expiry first without mutating caller input", () => {
    const earlier = share("share-earlier", 100);
    const later = share("share-later", 300);
    const middle = share("share-middle", 200);
    const input = [earlier, later, middle];
    const store = new TuiAppStore();

    store.replaceArtifactShares(input);

    assert.deepEqual(input, [earlier, later, middle]);
    assert.deepEqual(
        store.getState().artifactShares.map((entry) => entry.shareId),
        ["share-later", "share-middle", "share-earlier"]
    );
});

test("artifact share upsert replaces the existing id and reorders by the updated expiry", () => {
    const store = new TuiAppStore();
    store.replaceArtifactShares([
        share("share-one", 100),
        share("share-two", 200)
    ]);

    store.upsertArtifactShare({
        ...share("share-one", 400),
        state: "revoked"
    });

    assert.equal(store.getState().artifactShares.length, 2);
    assert.deepEqual(
        store.getState().artifactShares.map((entry) => [entry.shareId, entry.state]),
        [
            ["share-one", "revoked"],
            ["share-two", "active"]
        ]
    );
});

test("artifact transfer replacement and upsert keep one record per id in newest-created order", () => {
    const store = new TuiAppStore();
    const oldest = transfer("transfer-oldest", "2026-07-14T00:00:00.000Z", "queued");
    const newest = transfer("transfer-newest", "2026-07-16T00:00:00.000Z", "transferring");
    const middle = transfer("transfer-middle", "2026-07-15T00:00:00.000Z", "preparing");
    const input = [oldest, newest, middle];

    store.replaceArtifactTransfers(input);
    assert.deepEqual(input, [oldest, newest, middle]);
    assert.deepEqual(
        store.getState().artifactTransfers.map((entry) => entry.transferId),
        ["transfer-newest", "transfer-middle", "transfer-oldest"]
    );

    store.upsertArtifactTransfer({
        ...oldest,
        createdAt: "2026-07-17T00:00:00.000Z",
        status: "completed",
        transferredBytes: 10,
        updatedAt: "2026-07-17T00:00:01.000Z"
    });

    assert.equal(store.getState().artifactTransfers.length, 3);
    assert.deepEqual(
        store.getState().artifactTransfers.map((entry) => [entry.transferId, entry.status]),
        [
            ["transfer-oldest", "completed"],
            ["transfer-newest", "transferring"],
            ["transfer-middle", "preparing"]
        ]
    );
});

function share(shareId: string, expiresAtMs: number): ArtifactShareResult {
    return {
        blake3: "a".repeat(64),
        bytes: 10,
        downloadName: `${shareId}.bin`,
        expiresAtMs,
        mediaType: "application/octet-stream",
        shareId,
        source: { instance: "source-one", path: "./result.bin", type: "file" },
        state: "active",
        url: `https://example.test/${shareId}`
    };
}

function transfer(
    transferId: string,
    createdAt: string,
    status: ArtifactTransferRecord["status"]
): ArtifactTransferRecord {
    return {
        createdAt,
        source: { instance: "source-one", path: "./result.bin", type: "file" },
        status,
        target: { instance: "target-one", path: "/tmp/result.bin" },
        transferId,
        transferredBytes: 0,
        updatedAt: createdAt
    };
}
