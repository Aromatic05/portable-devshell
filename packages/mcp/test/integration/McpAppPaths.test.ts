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

test("MCP App assets and Live HTTP endpoints honor the public URL path prefix", async () => {
    const { Endpoint } = await import("@portable-devshell/shared");
    const http = new ControlHttpServer();
    const runtime = createTestMcpRuntimeState({ endpoint: new Endpoint({ host: "mcp-app-prefix-test" }) });
    const host = new McpHost({
        instances: [{ name: "demo" }],
        listenHost: "127.0.0.1", listenPort: 0,
        publicBaseUrl: "http://127.0.0.1/prefix",
        toolSource: runtime.toolSource,
    }, runtime.state, http);
    try {
        await runtime.contexts.initialize();
        await host.start();
        const origin = `http://127.0.0.1:${port(host.server.address)}`;
        const asset = (await readdir(mcpAppAssetDirectory)).find((name) => name.endsWith(".js"));
        assert.ok(asset);
        const prefixAsset = await fetch(`${origin}/prefix/mcpapp/assets/${asset}`);
        assert.equal(prefixAsset.status, 200);
        assert.equal(prefixAsset.headers.get("access-control-allow-origin"), "*");
        assert.equal((await fetch(`${origin}/mcpapp/assets/${asset}`)).status, 404);
        assert.equal((await fetch(`${origin}/prefix/api/live/demo/workspace/snapshot`)).status, 401);
        assert.equal((await fetch(`${origin}/api/live/demo/workspace/snapshot`)).status, 404);
        const request = { method: 'POST', headers: modernRpcHeaders('tools/list'),
            body: JSON.stringify(modernRpcRequest(1, 'tools/list')) };
        const prefixed = await fetch(`${origin}/prefix/demo/mcp`, request);
        assert.equal(prefixed.status, 200);
        assert.match(await prefixed.text(), /tools/u);
        assert.equal((await fetch(`${origin}/demo/mcp`, request)).status, 404);
    } finally {
        await host.dispose();
        await runtime.state.close();
        await runtime.contexts.close();
        await http.close();
    }
});
