import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type {
    ArtifactPayloadDescriptor,
    ArtifactTransferRecord,
    JsonValue
} from "@portable-devshell/shared";
import {
    ArtifactService,
    type ArtifactServiceEndpoint,
    type ArtifactServiceSchedule
} from "@portable-devshell/control/testing";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
);

class Deferred {
    readonly promise: Promise<void>;
    #resolve!: () => void;

    constructor() {
        this.promise = new Promise((resolve) => {
            this.#resolve = resolve;
        });
    }

    resolve(): void {
        this.#resolve();
    }
}

async function waitWithAbort(
    promise: Promise<void>,
    signal: AbortSignal | undefined,
    onAbort: () => void
): Promise<void> {
    if (signal === undefined) {
        await promise;
        return;
    }
    if (signal.aborted) {
        onAbort();
        throw new Error(String(signal.reason ?? "aborted"));
    }
    await new Promise<void>((resolve, reject) => {
        const abort = () => {
            onAbort();
            reject(new Error(String(signal.reason ?? "aborted")));
        };
        signal.addEventListener("abort", abort, { once: true });
        void promise.then(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, reject);
    });
}

class MemoryArtifactEndpoint implements ArtifactServiceEndpoint {
    readonly events: Array<{ type: string; data?: JsonValue }> = [];
    readonly closedPayloads: string[] = [];
    readonly payloadClosed = new Deferred();
    readonly abortedReceives: string[] = [];
    readonly received = new Map<string, Buffer>();
    readonly openStarted = new Deferred();
    readonly openAborted = new Deferred();
    readonly finishStarted = new Deferred();
    readonly finishAborted = new Deferred();
    readPayloadCalls = 0;
    writeReceiveCalls = 0;
    readonly #bytes: Buffer;
    readonly #finishGate?: Deferred;
    readonly #openGate?: Deferred;
    #nextReceive = 1;

    constructor(bytes: Buffer, openGate?: Deferred, finishGate?: Deferred) {
        this.#bytes = bytes;
        this.#finishGate = finishGate;
        this.#openGate = openGate;
    }

    async appendControlEvent(type: string, data?: JsonValue): Promise<void> {
        this.events.push({ type, data });
    }

    async openArtifactPayload(_input?: unknown, signal?: AbortSignal): Promise<{
        descriptor: ArtifactPayloadDescriptor;
        expiresAtMs: number;
        payloadId: string;
    }> {
        this.openStarted.resolve();
        if (this.#openGate !== undefined) {
            await waitWithAbort(this.#openGate.promise, signal, () => this.openAborted.resolve());
        }
        return {
            descriptor: {
                mediaType: "application/octet-stream",
                name: "payload.bin",
                payloadBlake3: "a".repeat(64),
                payloadBytes: this.#bytes.length,
                type: "file"
            },
            expiresAtMs: Date.now() + 60_000,
            payloadId: "payload-1"
        };
    }

    async readArtifactPayload(input: { maxBytes: number; offsetBytes: number; payloadId: string }) {
        this.readPayloadCalls += 1;
        const chunk = this.#bytes.subarray(input.offsetBytes, input.offsetBytes + input.maxBytes);
        const nextOffsetBytes = input.offsetBytes + chunk.length;
        return {
            content: chunk.toString("base64"),
            encoding: "base64" as const,
            eof: nextOffsetBytes >= this.#bytes.length,
            ...(nextOffsetBytes >= this.#bytes.length ? {} : { nextOffsetBytes }),
            offsetBytes: input.offsetBytes,
            payloadId: input.payloadId,
            returnedBytes: chunk.length,
            totalBytes: this.#bytes.length
        };
    }

    async closeArtifactPayload(payloadId: string): Promise<void> {
        this.closedPayloads.push(payloadId);
        this.payloadClosed.resolve();
    }

    async beginArtifactReceive(): Promise<{ nextOffsetBytes: number; receiveId: string }> {
        const receiveId = `receive-${this.#nextReceive++}`;
        this.received.set(receiveId, Buffer.alloc(0));
        return { nextOffsetBytes: 0, receiveId };
    }

    async writeArtifactReceive(input: { content: string; offsetBytes: number; receiveId: string }) {
        this.writeReceiveCalls += 1;
        const current = this.received.get(input.receiveId) ?? Buffer.alloc(0);
        assert.equal(input.offsetBytes, current.length);
        const next = Buffer.concat([current, Buffer.from(input.content, "base64")]);
        this.received.set(input.receiveId, next);
        return {
            nextOffsetBytes: next.length,
            receivedBytes: next.length,
            receiveId: input.receiveId
        };
    }

    async finishArtifactReceive(receiveId: string, signal?: AbortSignal) {
        this.finishStarted.resolve();
        if (this.#finishGate !== undefined) {
            await waitWithAbort(this.#finishGate.promise, signal, () => this.finishAborted.resolve());
        }
        return {
            blake3: "a".repeat(64),
            bytes: this.received.get(receiveId)?.length ?? 0,
            receiveId,
            targetPath: "/target/payload.bin"
        };
    }

    async abortArtifactReceive(receiveId: string): Promise<void> {
        this.abortedReceives.push(receiveId);
    }
}

class DirectTargetEndpoint extends MemoryArtifactEndpoint {
    readonly closedReceivers: string[] = [];
    failDirectOpen = false;

    async openArtifactDirectReceive(input: { expiresAtMs: number; receiveId: string }) {
        if (this.failDirectOpen) throw new Error("method not found");
        return {
            expiresAtMs: input.expiresAtMs,
            nextOffsetBytes: this.received.get(input.receiveId)?.length ?? 0,
            receiverId: `receiver-${input.receiveId}`,
            urls: [`memory://${input.receiveId}`]
        };
    }

    async closeArtifactDirectReceive(receiverId: string): Promise<void> {
        this.closedReceivers.push(receiverId);
    }

    writeDirect(url: string, offsetBytes: number, bytes: Buffer): number {
        const receiveId = url.slice("memory://".length);
        const current = this.received.get(receiveId) ?? Buffer.alloc(0);
        assert.equal(offsetBytes, current.length);
        const next = Buffer.concat([current, bytes]);
        this.received.set(receiveId, next);
        return next.length;
    }
}

class DirectSourceEndpoint extends MemoryArtifactEndpoint {
    directPushCalls = 0;
    failDirect = false;
    readonly #directBytes: Buffer;
    readonly #target: DirectTargetEndpoint;

    constructor(bytes: Buffer, target: DirectTargetEndpoint) {
        super(bytes);
        this.#directBytes = bytes;
        this.#target = target;
    }

    async pushArtifactPayloadDirect(input: {
        maxBytes: number;
        offsetBytes: number;
        payloadId: string;
        urls: string[];
    }) {
        this.directPushCalls += 1;
        if (this.failDirect) throw new Error("direct path unavailable");
        const chunk = this.#directBytes.subarray(input.offsetBytes, input.offsetBytes + input.maxBytes);
        const nextOffsetBytes = this.#target.writeDirect(input.urls[0]!, input.offsetBytes, chunk);
        return { nextOffsetBytes, pushedBytes: chunk.length };
    }
}

function resolver(endpoints: Record<string, ArtifactServiceEndpoint>) {
    return (name: string) => endpoints[name];
}

async function waitForStatus(
    service: ArtifactService,
    transferId: string,
    status: ArtifactTransferRecord["status"]
): Promise<ArtifactTransferRecord> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const record = service.getTransfer(transferId);
        if (record.status === status) {
            return record;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Transfer ${transferId} did not reach ${status}.`);
}

test("artifact transfer returns queued immediately and completes asynchronously", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-service");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const gate = new Deferred();
    const source = new MemoryArtifactEndpoint(Buffer.from("abcdefgh"), gate);
    const target = new MemoryArtifactEndpoint(Buffer.alloc(0));
    const service = new ArtifactService({
        chunkBytes: 3,
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    const started = await service.startTransfer(
        {
            operation: "start",
            sourcePath: "./payload.bin",
            sourceWorkspace: "/source",
            targetInstance: "target-b",
            targetPath: "/target/payload.bin",
            targetWorkspace: "/target"
        },
        "source-a"
    );
    assert.equal(started.transfer.status, "queued");

    gate.resolve();
    const completed = await service.waitForTransfer(started.transfer.transferId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.transferredBytes, 8);
    assert.deepEqual(target.received.get("receive-1"), Buffer.from("abcdefgh"));
    assert.deepEqual(source.closedPayloads, ["payload-1"]);
    assert.ok(source.events.some((event) => event.type === "artifact.transferCompleted"));
    assert.ok(target.events.some((event) => event.type === "artifact.transferCompleted"));
});

test("artifact transfer relays through Control unless direct transfer is explicitly enabled", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-direct-default");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const bytes = Buffer.from("relay-by-default");
    const target = new DirectTargetEndpoint(Buffer.alloc(0));
    const source = new DirectSourceEndpoint(bytes, target);
    const service = new ArtifactService({
        chunkBytes: 4,
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    const started = await service.startTransfer({
        operation: "start",
        sourcePath: "./payload.bin",
        sourceWorkspace: "/source",
        targetInstance: "target-b",
        targetPath: "/target/payload.bin",
        targetWorkspace: "/target"
    }, "source-a");
    const completed = await service.waitForTransfer(started.transfer.transferId);

    assert.equal(completed.status, "completed");
    assert.deepEqual(target.received.get("receive-1"), bytes);
    assert.equal(source.directPushCalls, 0);
    assert.equal(source.readPayloadCalls > 0, true);
    assert.equal(target.writeReceiveCalls > 0, true);
    assert.deepEqual(target.closedReceivers, []);
});

test("artifact transfer sends worker payload chunks directly without relaying bytes through Control", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-direct");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const bytes = Buffer.from("direct-worker-payload");
    const target = new DirectTargetEndpoint(Buffer.alloc(0));
    const source = new DirectSourceEndpoint(bytes, target);
    const service = new ArtifactService({
        chunkBytes: 5,
        directTransfer: true,
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    const started = await service.startTransfer({
        operation: "start",
        sourcePath: "./payload.bin",
        sourceWorkspace: "/source",
        targetInstance: "target-b",
        targetPath: "/target/payload.bin",
        targetWorkspace: "/target"
    }, "source-a");
    const completed = await service.waitForTransfer(started.transfer.transferId);

    assert.equal(completed.status, "completed");
    assert.deepEqual(target.received.get("receive-1"), bytes);
    assert.equal(source.directPushCalls > 0, true);
    assert.equal(source.readPayloadCalls, 0);
    assert.equal(target.writeReceiveCalls, 0);
    assert.deepEqual(target.closedReceivers, ["receiver-receive-1"]);
});

test("artifact transfer restarts receive and falls back to relay when direct push fails", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-direct-fallback");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const bytes = Buffer.from("relay-fallback");
    const target = new DirectTargetEndpoint(Buffer.alloc(0));
    const source = new DirectSourceEndpoint(bytes, target);
    source.failDirect = true;
    const service = new ArtifactService({
        chunkBytes: 4,
        directTransfer: true,
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    const started = await service.startTransfer({
        operation: "start",
        sourcePath: "./payload.bin",
        sourceWorkspace: "/source",
        targetInstance: "target-b",
        targetPath: "/target/payload.bin",
        targetWorkspace: "/target"
    }, "source-a");
    const completed = await service.waitForTransfer(started.transfer.transferId);

    assert.equal(completed.status, "completed");
    assert.deepEqual(target.abortedReceives, ["receive-1"]);
    assert.deepEqual(target.received.get("receive-2"), bytes);
    assert.equal(source.directPushCalls, 1);
    assert.equal(source.readPayloadCalls > 0, true);
    assert.equal(target.writeReceiveCalls > 0, true);
});

test("artifact transfer falls back when an older target worker has no direct receiver RPC", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-direct-old-worker");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const bytes = Buffer.from("old-worker-relay");
    const target = new DirectTargetEndpoint(Buffer.alloc(0));
    target.failDirectOpen = true;
    const source = new DirectSourceEndpoint(bytes, target);
    const service = new ArtifactService({
        chunkBytes: 4,
        directTransfer: true,
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    const started = await service.startTransfer({
        operation: "start",
        sourcePath: "./payload.bin",
        sourceWorkspace: "/source",
        targetInstance: "target-b",
        targetPath: "/target/payload.bin",
        targetWorkspace: "/target"
    }, "source-a");
    const completed = await service.waitForTransfer(started.transfer.transferId);

    assert.equal(completed.status, "completed");
    assert.deepEqual(target.abortedReceives, ["receive-1"]);
    assert.deepEqual(target.received.get("receive-2"), bytes);
    assert.equal(source.directPushCalls, 0);
    assert.equal(source.readPayloadCalls > 0, true);
});

test("artifact image view reads through the payload protocol and always closes the lease", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-image");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const source = new MemoryArtifactEndpoint(png);
    const service = new ArtifactService({
        chunkBytes: 7,
        resolveEndpoint: resolver({ "source-a": source }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    const image = await service.viewImage({ path: "./pixel.png", workspace: "/workspace" }, "source-a");

    assert.deepEqual(image, {
        bytes: png.length,
        content: png.toString("base64"),
        encoding: "base64",
        mediaType: "image/png",
        name: "payload.bin",
        source: {
            instance: "source-a",
            path: "./pixel.png",
            type: "file",
            workspace: "/workspace"
        }
    });
    assert.deepEqual(source.closedPayloads, ["payload-1"]);
});

test("artifact image view rejects unsupported and oversized payloads before returning content", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-image-invalid");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const unsupported = new MemoryArtifactEndpoint(Buffer.from("not an image"));
    const oversized = new MemoryArtifactEndpoint(Buffer.alloc(10 * 1024 * 1024 + 1));
    const service = new ArtifactService({
        resolveEndpoint: resolver({ oversized, unsupported }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    await assert.rejects(
        service.viewImage({ path: "./plain.txt", workspace: "/workspace" }, "unsupported"),
        (error: unknown) => (error as { code?: string }).code === "artifact.imageUnsupported"
    );
    await assert.rejects(
        service.viewImage({ path: "./huge.png", workspace: "/workspace" }, "oversized"),
        (error: unknown) => (error as { code?: string }).code === "artifact.imageTooLarge"
    );
    assert.deepEqual(unsupported.closedPayloads, ["payload-1"]);
    assert.deepEqual(oversized.closedPayloads, ["payload-1"]);
});

test("queued transfer resumes after restart while active transfer becomes interrupted", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-recovery");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const scheduled: Array<() => void> = [];
    const manualSchedule: ArtifactServiceSchedule = (task) => scheduled.push(task);
    const source = new MemoryArtifactEndpoint(Buffer.from("queued"));
    const target = new MemoryArtifactEndpoint(Buffer.alloc(0));
    const first = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        schedule: manualSchedule,
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await first.initialize();
    const queued = await first.startTransfer(
        {
            operation: "start",
            sourcePath: "./queued.bin",
            sourceWorkspace: "/source",
            targetInstance: "target-b",
            targetPath: "/target/queued.bin",
            targetWorkspace: "/target"
        },
        "source-a"
    );
    assert.equal(queued.transfer.status, "queued");
    assert.equal(scheduled.length, 1);

    const second = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await second.initialize();
    const recovered = await second.waitForTransfer(queued.transfer.transferId);
    assert.equal(recovered.status, "completed");

    const activeStorageDir = await createTestTempDirectory("artifact-interrupted");
    t.after(() => rm(activeStorageDir, { force: true, recursive: true }));
    const gate = new Deferred();
    const blockedSource = new MemoryArtifactEndpoint(Buffer.from("blocked"), gate);
    const active = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": blockedSource, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir: activeStorageDir
    });
    await active.initialize();
    const activeTransfer = await active.startTransfer(
        {
            operation: "start",
            sourcePath: "./blocked.bin",
            sourceWorkspace: "/source",
            targetInstance: "target-b",
            targetPath: "/target/blocked.bin",
            targetWorkspace: "/target"
        },
        "source-a"
    );
    await waitForStatus(active, activeTransfer.transfer.transferId, "preparing");
    await blockedSource.openStarted.promise;
    await active.stop();
    await blockedSource.openAborted.promise;

    const restarted = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": blockedSource, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir: activeStorageDir
    });
    await restarted.initialize();
    assert.equal(restarted.getTransfer(activeTransfer.transfer.transferId).status, "interrupted");
    const verified = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": blockedSource, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir: activeStorageDir
    });
    await verified.initialize();
    assert.equal(verified.getTransfer(activeTransfer.transfer.transferId).status, "interrupted");
    assert.deepEqual(blockedSource.closedPayloads, []);
});

test("control stop waits for an in-flight artifact commit and preserves completed state", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-commit-stop");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const finishGate = new Deferred();
    const source = new MemoryArtifactEndpoint(Buffer.from("committed"));
    const target = new MemoryArtifactEndpoint(Buffer.alloc(0), undefined, finishGate);
    const service = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();
    const started = await service.startTransfer({
        operation: "start",
        sourcePath: "./commit.bin",
        sourceWorkspace: "/source",
        targetInstance: "target-b",
        targetPath: "/target/commit.bin",
        targetWorkspace: "/target"
    }, "source-a");

    await waitForStatus(service, started.transfer.transferId, "committing");
    await target.finishStarted.promise;
    let stopSettled = false;
    const stopping = service.stop().then(() => { stopSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stopSettled, false);

    finishGate.resolve();
    await stopping;

    const reloaded = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await reloaded.initialize();
    assert.equal(reloaded.getTransfer(started.transfer.transferId).status, "completed");
});

test("artifact cancellation rolls back its in-memory state when persistence fails", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-cancel-persist-failure");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const scheduled: Array<() => void> = [];
    const source = new MemoryArtifactEndpoint(Buffer.from("queued"));
    const target = new MemoryArtifactEndpoint(Buffer.alloc(0));
    const service = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        schedule: (task) => scheduled.push(task),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();
    const started = await service.startTransfer({
        operation: "start",
        sourcePath: "./queued.bin",
        sourceWorkspace: "/source",
        targetInstance: "target-b",
        targetPath: "/target/queued.bin",
        targetWorkspace: "/target"
    }, "source-a");
    assert.equal(scheduled.length, 1);

    const transfersDir = join(storageDir, "transfers");
    await rm(transfersDir, { force: true, recursive: true });
    await writeFile(transfersDir, "not a directory", "utf8");
    await assert.rejects(service.cancelTransfer(started.transfer.transferId));

    assert.equal(service.getTransfer(started.transfer.transferId).status, "queued");
});

test("artifact share persists its payload lease and revoke closes it", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-share");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const source = new MemoryArtifactEndpoint(Buffer.from("share"));
    const service = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    const share = await service.createShare({ path: "./share.bin", workspace: "/workspace" }, "source-a");
    assert.equal(share.state, "active");
    assert.match(share.url, /^https:\/\/example\.test\/artifacts\/share\//u);
    assert.equal(service.listShares().length, 1);
    const revoked = await service.revokeShare(share.shareId);
    assert.equal(revoked.revoked, true);
    assert.deepEqual(source.closedPayloads, ["payload-1"]);
    assert.equal(service.listShares()[0]?.state, "revoked");
});

test("artifact share persists maxDownloads and completed download count across restart", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-share-download-count");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const source = new MemoryArtifactEndpoint(Buffer.from("share"));
    const options = {
        resolveEndpoint: resolver({ "source-a": source }),
        shareUrl: (token: string) => `https://example.test/artifacts/share/${token}`,
        storageDir
    };
    const first = new ArtifactService(options);
    await first.initialize();
    const share = await first.createShare({
        maxDownloads: 2,
        path: "./share.bin",
        workspace: "/workspace"
    }, "source-a");
    const token = new URL(share.url).pathname.split("/").at(-1)!;
    await first.beginShareDownload(token);
    await first.finishShareDownload(token, true);
    assert.equal(first.listShares()[0]?.downloadCount, 1);
    assert.equal(first.listShares()[0]?.maxDownloads, 2);
    await first.stop();

    const reloaded = new ArtifactService(options);
    await reloaded.initialize();
    t.after(() => reloaded.stop());
    assert.equal(reloaded.listShares()[0]?.downloadCount, 1);
    assert.equal(reloaded.listShares()[0]?.maxDownloads, 2);
    assert.equal(reloaded.listShares()[0]?.state, "active");
});

test("artifact share reserves maxDownloads slots and releases a failed download", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-share-download-reservation");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const source = new MemoryArtifactEndpoint(Buffer.from("share"));
    const service = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();
    t.after(() => service.stop());
    const share = await service.createShare({
        maxDownloads: 1,
        path: "./share.bin",
        workspace: "/workspace"
    }, "source-a");
    const token = new URL(share.url).pathname.split("/").at(-1)!;

    await service.beginShareDownload(token);
    await assert.rejects(
        service.beginShareDownload(token),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "artifact.shareExhausted"
    );
    await service.finishShareDownload(token, false);
    await service.beginShareDownload(token);
    await service.finishShareDownload(token, true);
    assert.equal(service.listShares()[0]?.state, "exhausted");
    assert.equal(service.listShares()[0]?.downloadCount, 1);
});

test("artifact share history bounds terminal records while preserving active shares", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-share-history");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const source = new MemoryArtifactEndpoint(Buffer.from("share"));
    const service = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir,
        terminalHistoryLimit: 2
    });
    await service.initialize();

    const active = await service.createShare({ path: "./active.bin", workspace: "/workspace" }, "source-a");
    const terminalIds: string[] = [];
    for (const name of ["old-1.bin", "old-2.bin", "old-3.bin"]) {
        const share = await service.createShare({ path: `./${name}`, workspace: "/workspace" }, "source-a");
        terminalIds.push(share.shareId);
        await service.revokeShare(share.shareId);
    }

    const shares = service.listShares();
    assert.equal(shares.some((share) => share.shareId === active.shareId && share.state === "active"), true);
    assert.equal(shares.some((share) => share.shareId === terminalIds[0]), false);
    assert.deepEqual(
        shares.filter((share) => share.state !== "active").map((share) => share.shareId).sort(),
        terminalIds.slice(-2).sort()
    );
});

test("artifact transfer history bounds terminal records while preserving an in-flight transfer", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-transfer-history");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    let source: MemoryArtifactEndpoint = new MemoryArtifactEndpoint(Buffer.from("transfer"));
    const target = new MemoryArtifactEndpoint(Buffer.alloc(0));
    const service = new ArtifactService({
        resolveEndpoint: (name) => name === "source-a" ? source : name === "target-b" ? target : undefined,
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir,
        terminalHistoryLimit: 2
    });
    await service.initialize();

    const terminalIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
        const started = await service.startTransfer({
            operation: "start",
            sourcePath: `./source-${index}.bin`,
            sourceWorkspace: "/source",
            targetInstance: "target-b",
            targetPath: `/target/${index}.bin`,
            targetWorkspace: "/target"
        }, "source-a");
        terminalIds.push(started.transfer.transferId);
        assert.equal((await service.waitForTransfer(started.transfer.transferId)).status, "completed");
    }

    const gate = new Deferred();
    source = new MemoryArtifactEndpoint(Buffer.from("active"), gate);
    const active = await service.startTransfer({
        operation: "start",
        sourcePath: "./active.bin",
        sourceWorkspace: "/source",
        targetInstance: "target-b",
        targetPath: "/target/active.bin",
        targetWorkspace: "/target"
    }, "source-a");
    await waitForStatus(service, active.transfer.transferId, "preparing");

    const transfers = service.listTransfers();
    assert.equal(transfers.some((transfer) => transfer.transferId === active.transfer.transferId && transfer.status === "preparing"), true);
    assert.equal(transfers.some((transfer) => transfer.transferId === terminalIds[0]), false);
    assert.deepEqual(
        transfers.filter((transfer) => transfer.status === "completed").map((transfer) => transfer.transferId).sort(),
        terminalIds.slice(-2).sort()
    );

    gate.resolve();
    await service.waitForTransfer(active.transfer.transferId);
});

test("completed transfer waiters resolve before zero-retention history is discarded", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-transfer-no-terminal-history");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const gate = new Deferred();
    const source = new MemoryArtifactEndpoint(Buffer.from("transfer"), gate);
    const target = new MemoryArtifactEndpoint(Buffer.alloc(0));
    const service = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir,
        terminalHistoryLimit: 0
    });
    await service.initialize();
    const started = await service.startTransfer({
        operation: "start",
        sourcePath: "./source.bin",
        sourceWorkspace: "/source",
        targetInstance: "target-b",
        targetPath: "/target/source.bin",
        targetWorkspace: "/target"
    }, "source-a");
    const completed = service.waitForTransfer(started.transfer.transferId);

    gate.resolve();
    assert.equal((await completed).status, "completed");
    assert.deepEqual(service.listTransfers(), []);
});

test("expired share is closed and unavailable after restart", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-share-expired");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const source = new MemoryArtifactEndpoint(Buffer.from("expired"));
    const options = {
        resolveEndpoint: resolver({ "source-a": source }),
        shareUrl: (token: string) => `https://example.test/artifacts/share/${token}`,
        storageDir
    };
    const service = new ArtifactService(options);
    await service.initialize();
    const share = await service.createShare({ path: "./expired.bin", workspace: "/workspace" }, "source-a");
    await service.stop();

    const recordPath = join(storageDir, "shares", `${share.shareId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
        result: { expiresAtMs: number };
    };
    record.result.expiresAtMs = Date.now() - 1;
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    const restarted = new ArtifactService(options);
    await restarted.initialize();
    assert.equal(restarted.listShares()[0]?.state, "expired");
    assert.deepEqual(source.closedPayloads, ["payload-1"]);
    await assert.rejects(
        restarted.resolveShare(new URL(share.url).pathname.split("/").at(-1)!),
        (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "artifact.shareExpired"
    );
});
test("artifact instance retirement revokes shares and queued transfers bound to the deleted generation", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-instance-retirement");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const scheduled: Array<() => void> = [];
    const source = new MemoryArtifactEndpoint(Buffer.from("source"));
    const other = new MemoryArtifactEndpoint(Buffer.from("other"));
    const target = new MemoryArtifactEndpoint(Buffer.alloc(0));
    const host = new MemoryArtifactEndpoint(Buffer.from("host"));
    const service = new ArtifactService({
        resolveEndpoint: (name, authorityInstance) => {
            if (name === "source-a") return source;
            if (name === "other") return other;
            if (name === "target-b") return target;
            if (name === "host" && (authorityInstance === "source-a" || authorityInstance === "other")) return host;
            return undefined;
        },
        schedule: (task) => scheduled.push(task),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    const directShare = await service.createShare(
        { path: "./direct.bin", workspace: "/source" },
        "source-a"
    );
    const hostShare = await service.createShare(
        { instance: "host", path: "./host.bin", workspace: "/host" },
        "source-a"
    );
    const unrelatedShare = await service.createShare(
        { path: "./other.bin", workspace: "/other" },
        "other"
    );

    const sourceTransfer = await service.startTransfer({
        operation: "start",
        sourcePath: "./source.bin",
        sourceWorkspace: "/source",
        targetInstance: "target-b",
        targetPath: "/target/source.bin",
        targetWorkspace: "/target"
    }, "source-a");
    const targetTransfer = await service.startTransfer({
        operation: "start",
        sourcePath: "./other.bin",
        sourceWorkspace: "/other",
        targetInstance: "source-a",
        targetPath: "/source/incoming.bin",
        targetWorkspace: "/source"
    }, "other");
    const hostAuthorityTransfer = await service.startTransfer({
        instance: "host",
        operation: "start",
        sourcePath: "./host.bin",
        sourceWorkspace: "/host",
        targetInstance: "target-b",
        targetPath: "/target/host.bin",
        targetWorkspace: "/target"
    }, "source-a");
    const unrelatedTransfer = await service.startTransfer({
        operation: "start",
        sourcePath: "./other.bin",
        sourceWorkspace: "/other",
        targetInstance: "target-b",
        targetPath: "/target/other.bin",
        targetWorkspace: "/target"
    }, "other");
    assert.equal(scheduled.length, 4);

    await service.retireInstance("source-a");

    const shares = new Map(service.listShares().map((share) => [share.shareId, share.state]));
    assert.equal(shares.get(directShare.shareId), "revoked");
    assert.equal(shares.get(hostShare.shareId), "revoked");
    assert.equal(shares.get(unrelatedShare.shareId), "active");
    assert.equal(service.getTransfer(sourceTransfer.transfer.transferId).status, "cancelled");
    assert.equal(service.getTransfer(targetTransfer.transfer.transferId).status, "cancelled");
    assert.equal(service.getTransfer(hostAuthorityTransfer.transfer.transferId).status, "cancelled");
    assert.equal(service.getTransfer(unrelatedTransfer.transfer.transferId).status, "queued");
});

test("artifact instance retirement aborts an in-flight transfer before waiting for terminal state", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-instance-retirement-active");
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const gate = new Deferred();
    const source = new MemoryArtifactEndpoint(Buffer.from("blocked"), gate);
    const target = new MemoryArtifactEndpoint(Buffer.alloc(0));
    const service = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();
    const started = await service.startTransfer({
        operation: "start",
        sourcePath: "./blocked.bin",
        sourceWorkspace: "/source",
        targetInstance: "target-b",
        targetPath: "/target/blocked.bin",
        targetWorkspace: "/target"
    }, "source-a");
    await source.openStarted.promise;

    const retirement = service.retireInstance("source-a");
    await source.openAborted.promise;
    await retirement;
    assert.equal(service.getTransfer(started.transfer.transferId).status, "cancelled");
    assert.deepEqual(source.closedPayloads, []);
});
