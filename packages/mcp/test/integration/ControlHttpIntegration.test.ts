import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

import { ControlHttpServer } from "../../../control/src/server/http/index.ts";
import { McpHost } from "../../src/server/Host.ts";
import { mcpAppAssetDirectory } from "../../src/mcpapp/app/Resource.ts";
import { createTestMcpRuntimeState } from "../ContextRuntime.ts";
import {
    modernRpcHeaders,
    modernRpcRequest,
} from "./ModernProtocol.ts";

function port(address: { port: number } | string | null): number {
    assert.ok(address !== null && typeof address !== "string");
    return address.port;
}

function mcpRequest(address: number, token?: string, path = "/demo/mcp"): Promise<Response> {
    const body = modernRpcRequest(1, "tools/list");
    return fetch(`http://127.0.0.1:${address}${path}`, {
        method: "POST",
        headers: {
            ...modernRpcHeaders("tools/list"),
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
    });
}

test("Control HTTP owns one shared listener for MCP Protocol, MCP App and Web routes", async () => {
    const http = new ControlHttpServer();
    const runtime = createTestMcpRuntimeState();
    const mcp = new McpHost(
        {
            instances: [{ name: "demo", auth: { enabled: true, provider: "token", token: "secret" } }],
            listenHost: "127.0.0.1",
            listenPort: 0,
            toolSource: runtime.toolSource,
        },
        runtime.state,
        http,
    );
    const web = http.acquire({ listenHost: "127.0.0.1", listenPort: 0 });
    const removeWeb = web.registerRawRoute("get", "/web/status", (_req, res) => { res.end("web-ok"); });
    try {
        await runtime.contexts.initialize();
        await mcp.start();
        await web.start();
        const address = port(mcp.server.address);
        assert.equal(address, port(web.address));
        assert.equal((await mcpRequest(address)).status, 401);
        const called = await mcpRequest(address, "secret");
        assert.equal(called.status, 200);
        assert.match(await called.text(), /tools/u);
        const asset = (await readdir(mcpAppAssetDirectory)).find((name) => name.endsWith(".js"));
        assert.ok(asset);
        const served = await fetch(`http://127.0.0.1:${address}/mcpapp/assets/${asset}`);
        assert.equal(served.status, 200);
        assert.equal(served.headers.get("access-control-allow-origin"), "*");
        assert.equal(await (await fetch(`http://127.0.0.1:${address}/web/status`)).text(), "web-ok");
        await mcp.stop();
        assert.equal((await mcpRequest(address)).status, 404);
        assert.equal(await (await fetch(`http://127.0.0.1:${address}/web/status`)).text(), "web-ok");
        await mcp.start();
        assert.equal((await mcpRequest(address, "secret")).status, 200);
        removeWeb();
        assert.equal((await fetch(`http://127.0.0.1:${address}/web/status`)).status, 404);
    } finally {
        await web.dispose();
        await mcp.dispose();
        await runtime.state.close();
        await runtime.contexts.close();
        await http.close();
    }
});

test("MCP OAuth metadata and unauthorized requests work through Control's native HTTP listener", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const storage = await mkdtemp(join(tmpdir(), "mcp-control-http-oauth-"));
    const http = new ControlHttpServer();
    const runtime = createTestMcpRuntimeState({ storageDir: storage });
    const host = new McpHost(
        {
            instances: [
                {
                    name: "demo",
                    auth: {
                        enabled: true,
                        provider: "oauth2",
                        oauth2: { requiredScopes: [], resourceName: "demo" },
                    },
                },
            ],
            listenHost: "127.0.0.1",
            listenPort: 0,
            publicBaseUrl: "http://127.0.0.1",
            storageDir: storage,
            toolSource: runtime.toolSource,
        },
        runtime.state,
        http,
    );
    try {
        await runtime.contexts.initialize();
        await host.start();
        const address = port(host.server.address);
        const metadata = await fetch(
            `http://127.0.0.1:${address}/.well-known/oauth-protected-resource/demo/mcp`,
            { signal: AbortSignal.timeout(5_000) },
        );
        assert.equal(metadata.status, 200);
        assert.match(await metadata.text(), /authorization_servers/u);
        const denied = await mcpRequest(address);
        assert.equal(denied.status, 401);
        const discovery = await fetch(
            `http://127.0.0.1:${address}/.well-known/oauth-authorization-server`,
            { signal: AbortSignal.timeout(5_000) },
        );
        assert.notEqual(discovery.status, 404);
    } finally {
        await host.dispose();
        await runtime.state.close();
        await runtime.contexts.close();
        await http.close();
        await rm(storage, { recursive: true, force: true });
    }
});

test("overlapping OAuth MCP Host generations keep active routes and revoke retired metadata", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const storage = await mkdtemp(join(tmpdir(), "mcp-oauth-host-generations-"));
    const http = new ControlHttpServer();
    const runtime = createTestMcpRuntimeState({ storageDir: storage });
    const web = http.acquire({ listenHost: "127.0.0.1", listenPort: 0 });
    const makeHost = (prefix: string) => new McpHost({
        instances: [{
            name: "demo",
            auth: { enabled: true, provider: "oauth2", oauth2: { requiredScopes: [], resourceName: "demo" } },
        }],
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: `http://127.0.0.1${prefix}`,
        storageDir: storage,
        toolSource: runtime.toolSource,
    }, runtime.state, http);
    const oldest = makeHost("/old");
    const sameUrl = makeHost("/old");
    const moved = makeHost("/new");
    try {
        await runtime.contexts.initialize();
        web.registerRawRoute("get", "/health", (_req, response) => { response.end("ok"); });
        await web.start();
        const origin = `http://127.0.0.1:${port(web.address)}`;
        const metadata = async (prefix: string) => await fetch(
            `${origin}/.well-known/oauth-protected-resource${prefix}/demo/mcp`,
            { signal: AbortSignal.timeout(5_000) },
        );

        await oldest.start();
        await sameUrl.start();
        assert.equal((await metadata("/old")).status, 200);
        assert.equal((await mcpRequest(port(web.address), undefined, "/old/demo/mcp")).status, 401);
        assert.equal((await mcpRequest(port(web.address))).status, 404);
        await oldest.stop();
        assert.equal((await metadata("/old")).status, 200);

        await moved.start();
        assert.equal((await metadata("/new")).status, 200);
        assert.equal((await mcpRequest(port(web.address), undefined, "/new/demo/mcp")).status, 401);
        await sameUrl.stop();
        assert.equal((await metadata("/old")).status, 404);
        assert.equal((await metadata("/new")).status, 200);
        assert.equal(await (await fetch(`${origin}/health`)).text(), "ok");

        await moved.stop();
        assert.equal((await metadata("/new")).status, 404);
        assert.equal(await (await fetch(`${origin}/health`)).text(), "ok");
    } finally {
        await oldest.dispose();
        await sameUrl.dispose();
        await moved.dispose();
        await web.dispose();
        await runtime.state.close();
        await runtime.contexts.close();
        await http.close();
        await rm(storage, { recursive: true, force: true });
    }
});
