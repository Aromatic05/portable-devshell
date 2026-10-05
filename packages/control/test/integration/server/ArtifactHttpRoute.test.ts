import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { HttpHost } from "@portable-devshell/mcp/testing";
import { requireTcpPort } from "../../../../../test/TestHttpSupport.ts";
import type {
    ArtifactPayloadDescriptor,
    JsonValue,
    MessageStream,
} from "@portable-devshell/shared";
import { ArtifactHttpRoute, artifactShareRoute } from "../../../src/artifact/route/Http.ts";
import { ArtifactService, type ArtifactServiceEndpoint } from "../../../src/artifact/Service.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

class MemoryShareEndpoint implements ArtifactServiceEndpoint {
    readonly closed: string[] = [];
    readonly #bytes: Buffer;

    constructor(bytes: Buffer) {
        this.#bytes = bytes;
    }

    async openArtifactPayload(): Promise<{
        descriptor: ArtifactPayloadDescriptor;
        expiresAtMs: number;
        payloadId: string;
    }> {
        return {
            descriptor: {
                mediaType: "application/octet-stream",
                name: 'result "final".bin',
                payloadBlake3: "a".repeat(64),
                payloadBytes: this.#bytes.length,
                type: "file",
            },
            expiresAtMs: Date.now() + 60_000,
            payloadId: "payload-1",
        };
    }

    async readArtifactPayload(input: {
        maxBytes: number;
        offsetBytes: number;
        payloadId: string;
    }) {
        const chunk = this.#bytes.subarray(
            input.offsetBytes,
            input.offsetBytes + input.maxBytes,
        );
        const nextOffsetBytes = input.offsetBytes + chunk.length;
        return {
            bytes: chunk,
            eof: nextOffsetBytes >= this.#bytes.length,
            ...(nextOffsetBytes >= this.#bytes.length
                ? {}
                : { nextOffsetBytes }),
            offsetBytes: input.offsetBytes,
            payloadId: input.payloadId,
            returnedBytes: chunk.length,
            totalBytes: this.#bytes.length,
        };
    }

    async closeArtifactPayload(payloadId: string): Promise<void> {
        this.closed.push(payloadId);
    }

    async beginArtifactReceive(): Promise<never> {
        throw new Error("not used");
    }

    async writeArtifactReceive(): Promise<never> {
        throw new Error("not used");
    }

    async finishArtifactReceive(): Promise<never> {
        throw new Error("not used");
    }

    async abortArtifactReceive(): Promise<void> {}
}

async function fixture(
    t: TestContext,
    publicBaseUrl?: string,
    maxDownloads?: number,
) {
    const storageDir = await createTestTempDirectory("artifact-http");
    const endpoint = new MemoryShareEndpoint(Buffer.from("0123456789abcdef"));
    const server = new HttpHost({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0,
    });
    const service = new ArtifactService({
        resolveEndpoint: (name) => (name === "source-a" ? endpoint : undefined),
        shareUrl: (token) => {
            const base = new URL(publicBaseUrl ?? "http://127.0.0.1");
            base.pathname = `${artifactShareRoute(base.toString())}/${token}`;
            return base.toString();
        },
        storageDir,
    });
    await service.initialize();
    new ArtifactHttpRoute(service, { publicBaseUrl }).install(server);
    await server.start();
    t.after(async () => {
        await server.stop();
        await service.stop();
        await rm(storageDir, { force: true, recursive: true });
    });
    const port = requireTcpPort(server.address);
    const baseUrl = `http://127.0.0.1:${port}`;
    const share = await service.createShare(
        {
            instance: "source-a",
            ...(maxDownloads === undefined ? {} : { maxDownloads }),
            path: "./result.bin",
            workspace: "/workspace",
        },
        "source-a",
    );
    const token = new URL(share.url).pathname.split("/").at(-1)!;
    const downloadUrl = `${baseUrl}${artifactShareRoute(publicBaseUrl)}/${token}`;
    return { downloadUrl, endpoint, service, share, token };
}

test("artifact HTTP route serves GET and HEAD with safe download headers", async (t) => {
    const { downloadUrl, service } = await fixture(t);

    const head = await fetch(downloadUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "16");
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("cache-control"), "private, no-store");
    assert.equal(head.headers.get("referrer-policy"), "no-referrer");
    assert.equal(head.headers.get("x-content-type-options"), "nosniff");
    assert.match(
        String(head.headers.get("content-disposition")),
        /^attachment;/u,
    );
    assert.equal(await head.text(), "");

    const fromSeq = service.snapshot().lastSeq + 1;
    const get = await fetch(downloadUrl);
    assert.equal(get.status, 200);
    assert.equal(await get.text(), "0123456789abcdef");

    const events = await readArtifactEvents(service, fromSeq);
    assert.equal(
        events.filter(
            (event) => event.type === "artifact.shareDownloaded",
        ).length,
        1,
    );
});

async function readArtifactEvents(
    service: ArtifactService,
    fromSeq: number,
): Promise<Array<{ type?: string }>> {
    const messages: Array<{ name?: string; payload?: JsonValue }> = [];
    let closed = false;
    const stream = {
        async send(message?: { name?: string; payload?: JsonValue }) {
            messages.push(message ?? {});
            closed = true;
        },
        onClose(listener: () => void) {
            if (closed) queueMicrotask(listener);
            return () => undefined;
        },
        onCancel() {
            return () => undefined;
        },
    } as unknown as MessageStream;

    await service.subscribe(stream, fromSeq);
    const seed = messages.find((message) => message.name === "seed");
    if (
        typeof seed?.payload !== "object" ||
        seed.payload === null ||
        Array.isArray(seed.payload) ||
        !Array.isArray(seed.payload.events)
    ) {
        return [];
    }
    return seed.payload.events.filter(
        (event): event is { type?: string } =>
            typeof event === "object" && event !== null && !Array.isArray(event),
    );
}

test("artifact HTTP route supports one byte range and rejects invalid or multiple ranges", async (t) => {
    const { downloadUrl } = await fixture(t);

    const range = await fetch(downloadUrl, { headers: { range: "bytes=4-9" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 4-9/16");
    assert.equal(range.headers.get("content-length"), "6");
    assert.equal(await range.text(), "456789");

    const suffix = await fetch(downloadUrl, { headers: { range: "bytes=-4" } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), "bytes 12-15/16");
    assert.equal(await suffix.text(), "cdef");

    const multiple = await fetch(downloadUrl, {
        headers: { range: "bytes=0-1,4-5" },
    });
    assert.equal(multiple.status, 416);
    assert.equal(multiple.headers.get("content-range"), "bytes */16");

    const outside = await fetch(downloadUrl, {
        headers: { range: "bytes=99-100" },
    });
    assert.equal(outside.status, 416);
    assert.equal(outside.headers.get("content-range"), "bytes */16");
});

test("artifact HTTP route enforces maxDownloads while HEAD and invalid ranges do not consume it", async (t) => {
    const { downloadUrl, service, share } = await fixture(t, undefined, 2);
    assert.equal(share.downloadCount, 0);
    assert.equal(share.maxDownloads, 2);

    assert.equal((await fetch(downloadUrl, { method: "HEAD" })).status, 200);
    assert.equal(
        (await fetch(downloadUrl, { headers: { range: "bytes=99-100" } }))
            .status,
        416,
    );
    assert.equal(service.listShares()[0]?.downloadCount, 0);

    const range = await fetch(downloadUrl, { headers: { range: "bytes=0-3" } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "0123");
    assert.equal(service.listShares()[0]?.downloadCount, 1);

    const full = await fetch(downloadUrl);
    assert.equal(full.status, 200);
    assert.equal(await full.text(), "0123456789abcdef");
    assert.equal(service.listShares()[0]?.downloadCount, 2);
    assert.equal(service.listShares()[0]?.state, "exhausted");

    assert.equal((await fetch(downloadUrl)).status, 410);
    assert.equal((await fetch(downloadUrl, { method: "HEAD" })).status, 410);
});

test("artifact HTTP route returns 410 after explicit revocation and never exposes token in body", async (t) => {
    const { downloadUrl, service, share, token } = await fixture(t);
    await service.revokeShare(share.shareId);

    const response = await fetch(downloadUrl);
    assert.equal(response.status, 410);
    const body = await response.text();
    assert.doesNotMatch(body, new RegExp(token, "u"));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("artifact HTTP route follows a publicBaseUrl path prefix", async (t) => {
    const { downloadUrl } = await fixture(t, "https://example.test/devshell");
    assert.match(downloadUrl, /\/devshell\/artifacts\/share\//u);
    const response = await fetch(downloadUrl);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "0123456789abcdef");
});
