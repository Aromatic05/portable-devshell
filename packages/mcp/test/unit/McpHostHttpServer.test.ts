import assert from "node:assert/strict";
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
