import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { AccessBinaryManager } from "../../src/builtin/binary/AccessBinaryManager.ts";

test("AccessBinaryManager honors explicit binaries without network access", async () => {
    const directory = await createTestTempDirectory("access-binary-override");
    let fetched = false;
    const manager = new AccessBinaryManager(directory, {
        fetch: (async () => {
            fetched = true;
            throw new Error("unexpected fetch");
        }) as typeof fetch,
    });
    try {
        assert.equal(await manager.resolve("cloudflared", "/custom/cloudflared"), "/custom/cloudflared");
        assert.equal(await manager.resolve("ssh"), "ssh");
        assert.equal(fetched, false);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("AccessBinaryManager downloads a direct cloudflared asset once", async () => {
    const directory = await createTestTempDirectory("access-binary-cloudflared");
    const requests: string[] = [];
    const manager = new AccessBinaryManager(directory, {
        arch: "x64",
        fetch: fakeFetch(requests, {
            "https://api.github.com/repos/cloudflare/cloudflared/releases/latest": jsonResponse({
                assets: [
                    {
                        browser_download_url: "https://downloads.example/cloudflared",
                        name: "cloudflared-linux-amd64",
                    },
                ],
                tag_name: "2026.9.0",
            }),
            "https://downloads.example/cloudflared": bytesResponse(Buffer.from("cloudflared-binary")),
        }),
        platform: "linux",
    });
    try {
        const first = await manager.resolve("cloudflared");
        assert.equal((await readFile(first)).toString(), "cloudflared-binary");
        assert.equal(await manager.resolve("cloudflared"), first);
        assert.deepEqual(requests, [
            "https://api.github.com/repos/cloudflare/cloudflared/releases/latest",
            "https://downloads.example/cloudflared",
        ]);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("AccessBinaryManager extracts frpc from the latest FRP tarball", async () => {
    const directory = await createTestTempDirectory("access-binary-frp");
    const archive = gzipSync(
        tarFile("frp_0.65.0_linux_amd64/frpc", Buffer.from("frpc-binary")),
    );
    const manager = new AccessBinaryManager(directory, {
        arch: "x64",
        fetch: fakeFetch([], {
            "https://api.github.com/repos/fatedier/frp/releases/latest": jsonResponse({
                assets: [
                    {
                        browser_download_url: "https://downloads.example/frp.tar.gz",
                        name: "frp_0.65.0_linux_amd64.tar.gz",
                    },
                ],
                tag_name: "v0.65.0",
            }),
            "https://downloads.example/frp.tar.gz": bytesResponse(archive),
        }),
        platform: "linux",
    });
    try {
        const executable = await manager.resolve("frp");
        assert.equal((await readFile(executable)).toString(), "frpc-binary");
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

function fakeFetch(
    requests: string[],
    responses: Readonly<Record<string, Response>>,
): typeof fetch {
    return (async (input: URL | RequestInfo) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requests.push(url);
        const response = responses[url];
        if (response === undefined) return new Response("not found", { status: 404 });
        return response.clone();
    }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
        status: 200,
    });
}

function bytesResponse(value: Buffer): Response {
    const body = value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
    return new Response(body, { status: 200 });
}

function tarFile(name: string, body: Buffer): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000700\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
    return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
}
