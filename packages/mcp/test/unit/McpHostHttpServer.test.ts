import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpHostHttpServer } from "@portable-devshell/mcp/testing";

test("MCP HTTP server rejects oversized request bodies before dispatch", async () => {
    const server = new McpHostHttpServer({
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    let handled = false;
    server.registerBinding("/demo/mcp", {
        async handleRequest() {
            handled = true;
        }
    } as never);

    try {
        await server.start();
        const address = server.address;
        assert.ok(typeof address === "object" && address !== null);
        const response = await fetch(`http://127.0.0.1:${address.port}/demo/mcp`, {
            body: JSON.stringify({ payload: "x".repeat(1024 * 1024) }),
            headers: { "content-type": "application/json" },
            method: "POST"
        });
        assert.equal(response.status, 413);
        assert.equal(handled, false);
    } finally {
        await server.stop();
    }
});

test("HTTP server serves WebUI assets with browser security and cache headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-web-assets-"));
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, "index.html"), "<!doctype html><title>devshell</title>", "utf8");
    await writeFile(join(directory, "assets", "app-abc123.js"), "export {};", "utf8");
    const server = new McpHostHttpServer({
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    server.registerStaticDirectory("/web", directory);

    try {
        await server.start();
        const address = server.address;
        assert.ok(typeof address === "object" && address !== null);
        const index = await fetch(`http://127.0.0.1:${address.port}/web/`);
        assert.equal(index.status, 200);
        assert.equal(index.headers.get("cache-control"), "no-cache");
        assert.match(index.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
        assert.equal(index.headers.get("x-content-type-options"), "nosniff");

        const asset = await fetch(`http://127.0.0.1:${address.port}/web/assets/app-abc123.js`);
        assert.equal(asset.status, 200);
        assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    } finally {
        await server.stop();
        await rm(directory, { force: true, recursive: true });
    }
});
