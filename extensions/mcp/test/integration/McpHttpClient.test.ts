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
        abort.signal,
    );
    t.after(async () => await client.close());

    const tools = await client.listTools(abort.signal);
    assert.equal(typeof tools, "object");
    assert.ok(tools !== null && !Array.isArray(tools));
    const toolList = (tools as { tools?: Array<{ name?: string }> }).tools;
    assert.ok(toolList?.some((tool) => tool.name === "echo"));

    const result = await client.callTool(
        "echo",
        { text: "hello" },
        abort.signal,
    );
    assert.deepEqual(result, {
        content: [{ text: "hello", type: "text" }],
    });
});

test("MCP HTTP client remains usable after a tool reports an error", async (t) => {
    const server = await startEchoServer();
    t.after(async () => await server.close());

    const abort = new AbortController();
    const client = await new McpHttpClientFactory("0.1.0").connect(
        { name: "echo", url: server.url },
        abort.signal,
    );
    t.after(async () => await client.close());

    const failed = await client.callTool("fail", {}, abort.signal);
    assert.equal(
        (failed as { isError?: boolean }).isError,
        true,
    );
    assert.deepEqual(
        await client.callTool("echo", { text: "still connected" }, abort.signal),
        { content: [{ text: "still connected", type: "text" }] },
    );
});

async function startEchoServer(stall?: { entered(): void; release: Promise<void> }): Promise<TestServer> {
    const mcp = new McpServer({ name: "mcp-extension-test", version: "1.0.0" });
    mcp.registerTool(
        "echo",
        {
            description: "Echo text",
            inputSchema: z.object({ text: z.string() }),
        },
        async ({ text }) => ({
            content: [{ text, type: "text" }],
        }),
    );
    mcp.registerTool(
        "fail",
        { description: "Return a tool error" },
        async () => {
            throw new Error("intentional tool failure");
        },
    );

    if (stall !== undefined) {
        mcp.registerTool("stall", { description: "Wait for test release" }, async () => {
            stall.entered();
            await stall.release;
            return { content: [{ type: "text", text: "released" }] };
        });
    }

    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
    });
    await mcp.connect(transport);

    const http = createServer((request, response) => {
        if (request.url !== "/mcp") {
            response.writeHead(404).end();
            return;
        }
        void transport.handleRequest(request, response).catch((error) => {
            if (!response.headersSent)
                response.writeHead(500, { "content-type": "text/plain" });
            response.end(
                error instanceof Error ? error.message : String(error),
            );
        });
    });
    await listen(http);
    const address = http.address();
    if (address === null || typeof address === "string")
        throw new Error("Expected a TCP test server address.");

    return {
        close: async () => {
            await mcp.close();
            await close(http);
        },
        url: `http://127.0.0.1:${address.port}/mcp`,
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
        server.close((error) =>
            error === undefined ? resolve() : reject(error),
        );
    });
}


test("MCP HTTP client aborts a stalled connect and the factory can connect again", { timeout: 8_000 }, async (t) => {
    const received = deferred();
    const stalled = createServer((_request, _response) => received.resolve());
    await listen(stalled);
    t.after(async () => {
        stalled.closeAllConnections();
        await close(stalled);
    });
    const address = stalled.address();
    assert.ok(address !== null && typeof address !== "string");
    const factory = new McpHttpClientFactory("0.1.0");
    const abort = new AbortController();
    const connecting = factory.connect({ name: "stalled", url: `http://127.0.0.1:${address.port}/mcp` }, abort.signal);
    const rejected = assert.rejects(connecting, /abort|cancel/i);
    await received.promise;
    abort.abort();
    await rejected;

    const server = await startEchoServer();
    t.after(async () => await server.close());
    const client = await factory.connect({ name: "recovered", url: server.url }, new AbortController().signal);
    t.after(async () => await client.close());
    assert.deepEqual(await client.callTool("echo", { text: "reconnected" }, new AbortController().signal), {
        content: [{ text: "reconnected", type: "text" }],
    });
});

test("MCP HTTP client cancels a stalled call without blocking another call on the same client", { timeout: 8_000 }, async (t) => {
    const entered = deferred();
    const release = deferred();
    const server = await startEchoServer({ entered: () => entered.resolve(), release: release.promise });
    t.after(async () => {
        release.resolve();
        await server.close();
    });
    const client = await new McpHttpClientFactory("0.1.0").connect({ name: "echo", url: server.url }, new AbortController().signal);
    t.after(async () => await client.close());
    const abort = new AbortController();
    const rejected = assert.rejects(client.callTool("stall", {}, abort.signal), /abort|cancel/i);
    await entered.promise;
    abort.abort();
    await rejected;
    assert.deepEqual(await client.callTool("echo", { text: "independent" }, new AbortController().signal), {
        content: [{ text: "independent", type: "text" }],
    });
    release.resolve();
});


function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}
