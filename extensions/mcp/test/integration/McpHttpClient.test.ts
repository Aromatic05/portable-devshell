import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import test from "node:test";

import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { McpHttpClientFactory } from "../../src/builtin/McpClientRuntime.ts";

interface TestServer {
    readonly url: string;
    close(): Promise<void>;
}

test("MCP HTTP client lists and calls tools through a real Streamable HTTP server", async (t) => {
    const server = await startEchoServer();
    t.after(async () => await server.close());

    const abort = new AbortController();
    const client = await new McpHttpClientFactory("0.1.0").connect(
        { name: "echo", url: server.url },
        abort.signal
    );
    t.after(async () => await client.close());

    const tools = await client.listTools(abort.signal);
    assert.equal(typeof tools, "object");
    assert.ok(tools !== null && !Array.isArray(tools));
    const toolList = (tools as { tools?: Array<{ name?: string }> }).tools;
    assert.ok(toolList?.some((tool) => tool.name === "echo"));

    const result = await client.callTool("echo", { text: "hello" }, abort.signal);
    assert.deepEqual(result, {
        content: [{ text: "hello", type: "text" }]
    });
});

async function startEchoServer(): Promise<TestServer> {
    const mcp = new McpServer({ name: "mcp-extension-test", version: "1.0.0" });
    mcp.registerTool(
        "echo",
        {
            description: "Echo text",
            inputSchema: z.object({ text: z.string() })
        },
        async ({ text }) => ({
            content: [{ text, type: "text" }]
        })
    );

    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);

    const http = createServer((request, response) => {
        if (request.url !== "/mcp") {
            response.writeHead(404).end();
            return;
        }
        void transport.handleRequest(request, response).catch((error) => {
            if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
            response.end(error instanceof Error ? error.message : String(error));
        });
    });
    await listen(http);
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP test server address.");

    return {
        close: async () => {
            await mcp.close();
            await close(http);
        },
        url: `http://127.0.0.1:${address.port}/mcp`
    };
}

async function listen(server: HttpServer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
}

async function close(server: HttpServer): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
    });
}
