import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HttpHost } from "@portable-devshell/mcp/testing";

test("MCP HTTP server rejects oversized request bodies before dispatch", async () => {
    const server = new HttpHost({
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
        const body = JSON.stringify({ payload: "x".repeat(1024 * 1024) });
        const response = await requestHttp(address.port, "/demo/mcp", {
            body,
            headers: {
                "content-length": String(Buffer.byteLength(body)),
                "content-type": "application/json"
            },
            method: "POST"
        });
        assert.equal(response.status, 413);
        assert.match(response.body, /exceeds/u);
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
    const server = new HttpHost({
        listenHost: "127.0.0.1",
        listenPort: 0
    });
    server.registerStaticDirectory("/web", directory);

    try {
        await server.start();
        const address = server.address;
        assert.ok(typeof address === "object" && address !== null);
        const index = await requestHttp(address.port, "/web/");
        assert.equal(index.status, 200);
        assert.equal(index.headers["cache-control"], "no-cache");
        assert.match(readHeader(index.headers, "content-security-policy"), /frame-ancestors 'none'/u);
        assert.equal(index.headers["x-content-type-options"], "nosniff");
        assert.match(index.body, /<title>devshell<\/title>/u);

        const asset = await requestHttp(address.port, "/web/assets/app-abc123.js");
        assert.equal(asset.status, 200);
        assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
        assert.equal(asset.body, "export {};");
    } finally {
        await server.stop();
        await rm(directory, { force: true, recursive: true });
    }
});

test("MCP binding auth is read from the current namespace registration", async () => {
    const server = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const binding = {
        async handleRequest(_request: unknown, response: { statusCode: number; end(): void }) {
            response.statusCode = 204;
            response.end();
        }
    };
    server.registerBinding("/demo/mcp", binding as never, {
        enabled: true,
        provider: "token",
        token: "first-token"
    });

    try {
        await server.start();
        const address = server.address;
        assert.ok(typeof address === "object" && address !== null);
        const initial = await requestHttp(address.port, "/demo/mcp", {
            body: "{}",
            headers: { authorization: "Bearer first-token", "content-type": "application/json" },
            method: "POST"
        });
        assert.equal(initial.status, 204);

        server.registerBinding("/demo/mcp", binding as never, {
            enabled: true,
            provider: "token",
            token: "second-token"
        });
        const stale = await requestHttp(address.port, "/demo/mcp", {
            body: "{}",
            headers: { authorization: "Bearer first-token", "content-type": "application/json" },
            method: "POST"
        });
        const current = await requestHttp(address.port, "/demo/mcp", {
            body: "{}",
            headers: { authorization: "Bearer second-token", "content-type": "application/json" },
            method: "POST"
        });
        assert.equal(stale.status, 401);
        assert.equal(current.status, 204);
    } finally {
        await server.stop();
    }
});

interface HttpResponse {
    body: string;
    headers: IncomingHttpHeaders;
    status: number;
}

async function requestHttp(
    port: number,
    path: string,
    options: {
        body?: string;
        headers?: Record<string, string>;
        method?: "GET" | "POST";
    } = {}
): Promise<HttpResponse> {
    return await new Promise<HttpResponse>((resolve, reject) => {
        const request = httpRequest({
            agent: false,
            headers: options.headers,
            host: "127.0.0.1",
            method: options.method ?? "GET",
            path,
            port
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer | string) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.once("error", reject);
            response.once("end", () => {
                resolve({
                    body: Buffer.concat(chunks).toString("utf8"),
                    headers: response.headers,
                    status: response.statusCode ?? 0
                });
            });
        });
        request.once("error", reject);
        request.end(options.body);
    });
}

function readHeader(headers: IncomingHttpHeaders, name: string): string {
    const value = headers[name];
    return Array.isArray(value) ? value.join(", ") : value ?? "";
}
