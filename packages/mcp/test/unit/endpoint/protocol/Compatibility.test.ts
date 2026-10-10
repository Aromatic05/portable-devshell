import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import type {
    ContextTransport,
    JsonValue,
    ToolCallApi,
    ToolDefinition,
} from "@portable-devshell/shared";
import { McpEndpointBinding } from "@portable-devshell/mcp/testing";

import { requireTcpPort } from "../../../../../../test/TestHttpSupport.ts";
import {
    createTestMcpEndpoint,
} from "../../../ContextRuntime.ts";
import { TestToolSource } from "../../../support/ToolSource.ts";
import {
    McpEndpointCatalog,
} from "../../../../src/protocol/tool/Catalog.ts";
import {
    McpEndpointDispatch,
} from "../../../../src/protocol/dispatch/Dispatch.ts";

const workerTool: ToolDefinition = {
    description: "Run a command.",
    group: "bash",
    inputSchema: {
        additionalProperties: false,
        properties: { command: { type: "string" } },
        required: ["command"],
        type: "object",
    },
    name: "bash_run",
    outputSchema: { type: "object" },
    requiredCapabilities: ["execute"],
};

/**
 * The modern endpoint owns a single tool vocabulary. Every name the removed
 * v0.6.15 alias/tombstone table used to answer must be rejected outright:
 * never listed, never aliased, never tombstoned.
 */
async function assertStrictlyRejected(names: readonly string[]): Promise<void> {
    const source = new TestToolSource();
    source.register("alpha", [workerTool]);
    const context: Pick<ContextTransport, "resolve"> = {
        async resolve() {
            throw new Error("removed legacy tools must not resolve a Context");
        },
    };
    const tools: ToolCallApi = {
        async call() {
            throw new Error("removed legacy tools must not reach ToolCall");
        },
    };
    const catalog = new McpEndpointCatalog({ instanceName: "alpha", source });
    const dispatch = new McpEndpointDispatch({
        catalog,
        context,
        instanceName: "alpha",
        tools,
    });

    const listed = catalog.listTools().map((tool) => tool.name);
    assert.deepEqual(listed, ["bash_run"]);
    for (const name of names) {
        assert.equal(listed.includes(name), false, name);
        await assert.rejects(
            dispatch.callTool(
                name,
                {},
                { principal: "user-alpha", requestId: `req-${name}` },
            ),
            (error: unknown) =>
                (error as { code?: string }).code ===
                "core.toolSchemaUnavailable",
            name,
        );
    }
}

test("v0.6.15 MCP App control tools are strictly rejected instead of aliased", async () => {
    await assertStrictlyRejected([
        "workspace_goal_continue",
        "workspace_reentry_control",
    ]);
});

test("incompatible legacy MCP schemas are strictly rejected instead of tombstoned", async () => {
    await assertStrictlyRejected([
        "context_message_read",
        "file_write",
        "tmux_capture",
        "tmux_reclaim",
        "tmux_send",
    ]);
});

test("control-plane MCP tools removed in 0.6.17 are strictly rejected", async () => {
    await assertStrictlyRejected([
        "artifact_share",
        "instance_create",
        "instance_list",
        "instance_status",
        "instance_stop",
    ]);
});

test("legacy instance Context attachment tools are strictly rejected", async () => {
    await assertStrictlyRejected(["instance_connect", "instance_start"]);
});

test("legacy 2025 protocol negotiation is strictly rejected by the modern binding", async () => {
    const binding = new McpEndpointBinding(
        createTestMcpEndpoint({ instanceName: "demo" }),
    );
    const server = await createBindingServer(binding);

    try {
        const response = await postJson(
            server.url,
            {
                id: "req-legacy-initialize",
                jsonrpc: "2.0",
                method: "initialize",
                params: {
                    capabilities: {},
                    clientInfo: { name: "legacy-client", version: "0.0.0" },
                    protocolVersion: "2025-11-25",
                },
            },
            { "mcp-method": "initialize", "mcp-protocol-version": "2025-11-25" },
        );

        assert.equal(response.status, 400);
        assert.equal(response.body.result, undefined);
        assert.equal(response.body.error?.code, -32022);
        assert.deepEqual(response.body.error?.data?.supported, ["2026-07-28"]);
        assert.equal(response.body.error?.data?.requested, "2025-11-25");
    } finally {
        await server.close();
    }
});

interface JsonRpcErrorBody {
    code?: number;
    data?: { requested?: JsonValue; supported?: JsonValue };
}

interface JsonRpcResponseBody {
    error?: JsonRpcErrorBody;
    result?: JsonValue;
}

async function createBindingServer(binding: McpEndpointBinding) {
    const server = createServer((request, response) => {
        void handleRequest(binding, request, response);
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const port = requireTcpPort(server.address());

    return {
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve();
                });
            });
        },
        url: `http://127.0.0.1:${port}/mcp`,
    };
}

async function handleRequest(
    binding: McpEndpointBinding,
    request: IncomingMessage,
    response: ServerResponse,
) {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body =
        chunks.length === 0
            ? {}
            : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue);
    await binding.handleRequest(request, response, body);
}

async function postJson(
    url: string,
    body: JsonValue,
    extraHeaders?: Record<string, string>,
) {
    const response = await fetch(url, {
        body: JSON.stringify(body),
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...extraHeaders,
        },
        method: "POST",
    });

    const text = await response.text();
    const data = text
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
    const parsed = JSON.parse(data.at(-1) ?? text) as JsonRpcResponseBody;

    return {
        body: parsed,
        headers: response.headers,
        status: response.status,
    };
}
