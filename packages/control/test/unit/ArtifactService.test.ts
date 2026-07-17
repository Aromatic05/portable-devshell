import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

class MemoryArtifactEndpoint implements ArtifactServiceEndpoint {
    readonly events: Array<{ type: string; data?: JsonValue }> = [];
    readonly closedPayloads: string[] = [];
    readonly abortedReceives: string[] = [];
    readonly received = new Map<string, Buffer>();
    readonly openStarted = new Deferred();
    readonly #bytes: Buffer;
    readonly #openGate?: Deferred;
    #nextReceive = 1;

    constructor(bytes: Buffer, openGate?: Deferred) {
        this.#bytes = bytes;
        this.#openGate = openGate;
    }

    async appendControlEvent(type: string, data?: JsonValue): Promise<void> {
        this.events.push({ type, data });
    }

    async openArtifactPayload(): Promise<{
        descriptor: ArtifactPayloadDescriptor;
        expiresAtMs: number;
        payloadId: string;
    }> {
        this.openStarted.resolve();
        await this.#openGate?.promise;
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
    }

    async beginArtifactReceive(): Promise<{ nextOffsetBytes: number; receiveId: string }> {
        const receiveId = `receive-${this.#nextReceive++}`;
        this.received.set(receiveId, Buffer.alloc(0));
        return { nextOffsetBytes: 0, receiveId };
    }

    async writeArtifactReceive(input: { content: string; offsetBytes: number; receiveId: string }) {
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

    async finishArtifactReceive(receiveId: string) {
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
    const storageDir = await mkdtemp(join(tmpdir(), "artifact-service-"));
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
            targetInstance: "target-b",
            targetPath: "/target/payload.bin"
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

test("artifact image view reads through the payload protocol and always closes the lease", async (t) => {
    const storageDir = await mkdtemp(join(tmpdir(), "artifact-image-"));
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const source = new MemoryArtifactEndpoint(png);
    const service = new ArtifactService({
        chunkBytes: 7,
        resolveEndpoint: resolver({ "source-a": source }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    const image = await service.viewImage({ path: "./pixel.png" }, "source-a");

    assert.deepEqual(image, {
        bytes: png.length,
        content: png.toString("base64"),
        encoding: "base64",
        mediaType: "image/png",
        name: "payload.bin",
        source: {
            instance: "source-a",
            path: "./pixel.png",
            type: "file"
        }
    });
    assert.deepEqual(source.closedPayloads, ["payload-1"]);
});

test("artifact image view rejects unsupported and oversized payloads before returning content", async (t) => {
    const storageDir = await mkdtemp(join(tmpdir(), "artifact-image-invalid-"));
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
        service.viewImage({ path: "./plain.txt" }, "unsupported"),
        (error: unknown) => (error as { code?: string }).code === "artifact.imageUnsupported"
    );
    await assert.rejects(
        service.viewImage({ path: "./huge.png" }, "oversized"),
        (error: unknown) => (error as { code?: string }).code === "artifact.imageTooLarge"
    );
    assert.deepEqual(unsupported.closedPayloads, ["payload-1"]);
    assert.deepEqual(oversized.closedPayloads, ["payload-1"]);
});

test("queued transfer resumes after restart while active transfer becomes interrupted", async (t) => {
    const storageDir = await mkdtemp(join(tmpdir(), "artifact-recovery-"));
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
            targetInstance: "target-b",
            targetPath: "/target/queued.bin"
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

    const activeStorageDir = await mkdtemp(join(tmpdir(), "artifact-interrupted-"));
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
            targetInstance: "target-b",
            targetPath: "/target/blocked.bin"
        },
        "source-a"
    );
    await waitForStatus(active, activeTransfer.transfer.transferId, "preparing");
    await blockedSource.openStarted.promise;
    await active.stop();

    const restarted = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": blockedSource, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir: activeStorageDir
    });
    await restarted.initialize();
    assert.equal(restarted.getTransfer(activeTransfer.transfer.transferId).status, "interrupted");
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const verified = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": blockedSource, "target-b": target }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir: activeStorageDir
    });
    await verified.initialize();
    assert.equal(verified.getTransfer(activeTransfer.transfer.transferId).status, "interrupted");
    assert.deepEqual(blockedSource.closedPayloads, ["payload-1"]);
});

test("artifact share persists its payload lease and revoke closes it", async (t) => {
    const storageDir = await mkdtemp(join(tmpdir(), "artifact-share-"));
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const source = new MemoryArtifactEndpoint(Buffer.from("share"));
    const service = new ArtifactService({
        resolveEndpoint: resolver({ "source-a": source }),
        shareUrl: (token) => `https://example.test/artifacts/share/${token}`,
        storageDir
    });
    await service.initialize();

    const share = await service.createShare({ path: "./share.bin" }, "source-a");
    assert.equal(share.state, "active");
    assert.match(share.url, /^https:\/\/example\.test\/artifacts\/share\//u);
    assert.equal(service.listShares().length, 1);
    const revoked = await service.revokeShare(share.shareId);
    assert.equal(revoked.revoked, true);
    assert.deepEqual(source.closedPayloads, ["payload-1"]);
    assert.equal(service.listShares()[0]?.state, "revoked");
});

test("expired share is closed and unavailable after restart", async (t) => {
    const storageDir = await mkdtemp(join(tmpdir(), "artifact-share-expired-"));
    t.after(() => rm(storageDir, { force: true, recursive: true }));
    const source = new MemoryArtifactEndpoint(Buffer.from("expired"));
    const options = {
        resolveEndpoint: resolver({ "source-a": source }),
        shareUrl: (token: string) => `https://example.test/artifacts/share/${token}`,
        storageDir
    };
    const service = new ArtifactService(options);
    await service.initialize();
    const share = await service.createShare({ path: "./expired.bin" }, "source-a");
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