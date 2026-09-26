import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";

import type {
    ExtensionManagedProcess,
    ExtensionProcessCapability,
    ExtensionProcessStartInput,
} from "@portable-devshell/extension";

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
    const url = "https://downloads.example/cloudflared";
    const bytes = Buffer.from("cloudflared-binary");
    const manager = new AccessBinaryManager(directory, {
        arch: "x64",
        fetch: fakeFetch(requests, {
            [url]: bytesResponse(bytes),
        }),
        platform: "linux",
        resolveManagedAsset: () => ({
            archive: "raw",
            sha256: sha256(bytes),
            url,
            version: "2026.9.3",
        }),
    });
    try {
        const first = await manager.resolve("cloudflared");
        assert.equal((await readFile(first)).toString(), "cloudflared-binary");
        assert.equal(await manager.resolve("cloudflared"), first);
        assert.deepEqual(requests, [url]);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("AccessBinaryManager rejects a modified pinned cloudflared asset", async () => {
    const directory = await createTestTempDirectory("access-binary-integrity");
    const requests: string[] = [];
    const url =
        "https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-linux-amd64";
    const manager = new AccessBinaryManager(directory, {
        arch: "x64",
        fetch: fakeFetch(requests, {
            [url]: bytesResponse(Buffer.from("modified-cloudflared")),
        }),
        platform: "linux",
    });
    try {
        await assert.rejects(
            manager.resolve("cloudflared"),
            /integrity check failed/u,
        );
        assert.deepEqual(requests, [url]);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("AccessBinaryManager downloads through the managed process capability", async () => {
    const directory = await createTestTempDirectory("access-binary-managed");
    const starts: ExtensionProcessStartInput[] = [];
    const url = "https://downloads.example/cloudflared";
    const bytes = Buffer.from("managed-cloudflared");
    const processes: ExtensionProcessCapability = {
        async start(input) {
            starts.push(input);
            const output = input.args?.[2];
            assert.ok(output);
            await writeFile(output, bytes);
            return managedProcess({ code: 0 });
        },
    };
    const manager = new AccessBinaryManager(directory, {
        arch: "x64",
        fetch: (async () => {
            throw new Error("sandbox fetch must not be used");
        }) as typeof fetch,
        platform: "linux",
        processes,
        resolveManagedAsset: () => ({
            archive: "raw",
            sha256: sha256(bytes),
            url,
            version: "2026.9.3",
        }),
    });
    try {
        const executable = await manager.resolve("cloudflared");
        assert.equal((await readFile(executable)).toString(), "managed-cloudflared");
        assert.equal(starts.length, 1);
        assert.equal(starts[0]?.command, process.execPath);
        assert.match(starts[0]?.args?.[0] ?? "", /DownloadWorker\.js$/u);
        assert.equal(starts[0]?.args?.[1], url);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("AccessBinaryManager verifies and extracts frpc from a pinned FRP tarball", async () => {
    const directory = await createTestTempDirectory("access-binary-frp");
    const archive = gzipSync(
        tarFile("frp_0.71.0_linux_amd64/frpc", Buffer.from("frpc-binary")),
    );
    const url = "https://downloads.example/frp.tar.gz";
    const manager = new AccessBinaryManager(directory, {
        arch: "x64",
        fetch: fakeFetch([], {
            [url]: bytesResponse(archive),
        }),
        platform: "linux",
        resolveManagedAsset: () => ({
            archive: "tar.gz",
            sha256: sha256(archive),
            url,
            version: "0.71.0",
        }),
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

function bytesResponse(value: Buffer): Response {
    const body = value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
    return new Response(body, { status: 200 });
}

function sha256(value: Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function managedProcess(exit: { code?: number; signal?: string }): ExtensionManagedProcess {
    return {
        closed: Promise.resolve(exit),
        onMessage: () => () => undefined,
        onStderr: () => () => undefined,
        onStdout: () => () => undefined,
        async send() {},
        async terminate() {},
    };
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
