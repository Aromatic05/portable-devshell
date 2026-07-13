import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpHostHttpServer } from "@portable-devshell/mcp";
import type { ArtifactPayloadDescriptor, JsonValue } from "@portable-devshell/shared";
import {
    ArtifactHttpRoute,
    ArtifactService,
    artifactShareRoute,
    type ArtifactServiceEndpoint
} from "@portable-devshell/control";

class MemoryShareEndpoint implements ArtifactServiceEndpoint {
    readonly events: Array<{ type: string; data?: JsonValue }> = [];
    readonly closed: string[] = [];
    readonly #bytes: Buffer;

    constructor(bytes: Buffer) {
        this.#bytes = bytes;
    }

    async appendControlEvent(type: string, data?: JsonValue): Promise<void> {
        this.events.push({ type, data });
    }

    async openArtifactPayload(): Promise<{
        descriptor: ArtifactPayloadDescriptor;
        expiresAtMs: number;
        payloadId: string;
    }> {
        return {
            descriptor: {
                mediaType: "application/octet-stream",
                name: "result \"final\".bin",
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
    t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never,
    publicBaseUrl?: string
) {
    const storageDir = await mkdtemp(join(tmpdir(), "artifact-http-"));
    const endpoint = new MemoryShareEndpoint(Buffer.from("0123456789abcdef"));
    const server = new McpHostHttpServer({
        auth: { enabled: false, provider: "none" },
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    const service = new ArtifactService({
        resolveEndpoint: (name) => (name === "source-a" ? endpoint : undefined),
        shareUrl: (token) => {
            const base = new URL(publicBaseUrl ?? "http://127.0.0.1");
            base.pathname = `${artifactShareRoute(base.toString())}/${token}`;
            return base.toString();
        },
        storageDir
    });
    await service.initialize();
    new ArtifactHttpRoute(service, { publicBaseUrl }).install(server);
    await server.start();
    t.after(async () => {
        await server.stop();
        await service.stop();
        await rm(storageDir, { force: true, recursive: true });
    });
    const address = server.address;
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const share = await service.createShare({ instance: "source-a", path: "./result.bin" }, "source-a");
    const token = new URL(share.url).pathname.split("/").at(-1)!;
    const downloadUrl = `${baseUrl}${artifactShareRoute(publicBaseUrl)}/${token}`;
    return { downloadUrl, endpoint, service, share, token };
}

test("artifact HTTP route serves GET and HEAD with safe download headers", async (t) => {
    const { downloadUrl, endpoint } = await fixture(t);

    const head = await fetch(downloadUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "16");
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("cache-control"), "private, no-store");
    assert.equal(head.headers.get("referrer-policy"), "no-referrer");
    assert.equal(head.headers.get("x-content-type-options"), "nosniff");
    assert.match(String(head.headers.get("content-disposition")), /^attachment;/u);
    assert.equal(await head.text(), "");

    const get = await fetch(downloadUrl);
    assert.equal(get.status, 200);
    assert.equal(await get.text(), "0123456789abcdef");
    assert.equal(
        endpoint.events.filter((event) => event.type === "artifact.shareDownloaded").length,
        1
    );
});

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

    const multiple = await fetch(downloadUrl, { headers: { range: "bytes=0-1,4-5" } });
    assert.equal(multiple.status, 416);
    assert.equal(multiple.headers.get("content-range"), "bytes */16");

    const outside = await fetch(downloadUrl, { headers: { range: "bytes=99-100" } });
    assert.equal(outside.status, 416);
    assert.equal(outside.headers.get("content-range"), "bytes */16");
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