import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpEndpointBinding, McpEndpointWorker, type McpInstanceGateway } from "@portable-devshell/mcp";

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

interface CommandResult {
    exitCode: number | null;
    stderr: string;
    stdout: string;
}

interface ToolDefinition {
    requiredCapabilities: readonly ("read" | "write" | "execute" | "session")[];
    description: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
}

test("initialize succeeds over SDK transport", async () => {
    const binding = createBinding();
    const server = await createBindingServer(binding);

    try {
        const response = await postJson(server.url, await readFixture("mcp-initialize.json"));

        assert.equal(response.status, 200);
        assert.equal(typeof response.body.result?.protocolVersion, "string");
        assert.equal(response.body.result?.serverInfo?.name, "portable-devshell-mcp");
        assert.equal(typeof response.headers.get("mcp-session-id"), "string");
    } finally {
        await server.close();
        await binding.close();
    }
});

test("session lifecycle emits MCP session events", async () => {
    const harness = createWorkerHarness();
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        await initialize(server.url);
        assert.deepEqual(
            harness.events.map((event) => event.type),
            ["mcp.sessionOpened"]
        );

        await binding.close();
        assert.deepEqual(
            harness.events.map((event) => event.type),
            ["mcp.sessionOpened", "mcp.sessionClosed"]
        );
    } finally {
        await server.close();
        await binding.close();
    }
});

test("session close also releases snapshots on routed instances", async () => {
    const harness = createWorkerHarness();
    const released: string[] = [];
    const endpoint = new McpEndpointWorker({
        gateway: {
            async closeFileSession(sessionId: string) {
                released.push(sessionId);
            }
        } as never,
        instanceName: "demo-local",
        policy: { capabilities: ["read"], groups: ["file"] },
        worker: harness.worker
    });

    await endpoint.appendSessionClosed("session-routed");

    assert.deepEqual(released, ["session-routed"]);
    assert.deepEqual(harness.events, [
        { data: { sessionId: "session-routed" }, type: "mcp.sessionClosed" }
    ]);
});

test("tools/list uses group and capability filtering", async () => {
    const binding = createBinding();
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(server.url, await readFixture("mcp-tools-list.json"), session.headers);

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.result?.tools.map((tool: { name: string }) => tool.name), ["bash_run"]);
    } finally {
        await server.close();
        await binding.close();
    }
});

test("tools/call delegates to WorkerInstance.callTool", async () => {
    const harness = createWorkerHarness();
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(server.url, await readFixture("mcp-tools-call.json"), session.headers);

        assert.equal(response.status, 200);
        assert.equal(harness.calls.length, 1);
        assert.deepEqual(harness.calls[0]?.input, { command: "pwd" });
        assert.equal(harness.calls[0]?.requestId, "req-tools-call");
        assert.equal(harness.calls[0]?.sessionId, session.headers["mcp-session-id"]);
        assert.equal(harness.calls[0]?.source, "mcp");
        assert.equal(harness.calls[0]?.toolName, "bash_run");
        assert.deepEqual(harness.events.map((event) => event.type), ["mcp.sessionOpened", "mcp.toolCalled"]);
        assert.deepEqual(harness.events[1]?.data, {
            requestId: "req-tools-call",
            sessionId: session.headers["mcp-session-id"],
            source: "mcp",
            toolName: "bash_run"
        });
        assert.equal(response.body.result?.isError, false);
    } finally {
        await server.close();
        await binding.close();
    }
});

test("instance_list returns object structured content through SDK transport", async () => {
    const harness = createWorkerHarness({ hasToolSchemaCache: false, ready: false, tools: [] });
    const gateway: McpInstanceGateway = {
        assertReady() {},
        async callTool() {
            return {};
        },
        async createSshInstance() {
            return {};
        },
        async listInstances() {
            return [{ name: "demo" }];
        },
        listTools() {
            return [];
        },
        async startInstance() {
            return {};
        },
        async statusInstance() {
            return {};
        },
        async stopInstance() {
            return {};
        }
    };
    const binding = new McpEndpointBinding(
        new McpEndpointWorker({
            gateway,
            instanceName: "demo",
            policy: { capabilities: ["manage"], groups: ["instance"] },
            worker: harness.worker
        })
    );
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(
            server.url,
            {
                id: "req-instance-list",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    arguments: {},
                    name: "instance_list"
                }
            },
            session.headers
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.error, undefined);
        assert.deepEqual(response.body.result?.structuredContent, {
            instances: [{ name: "demo" }]
        });
    } finally {
        await server.close();
        await binding.close();
    }
});

test("tools/list returns cached schema while the instance is not ready", async () => {
    const binding = createBinding(createWorkerHarness({ ready: false }));
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(server.url, await readFixture("mcp-tools-list.json"), session.headers);

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.result?.tools.map((tool: { name: string }) => tool.name), ["bash_run"]);
    } finally {
        await server.close();
        await binding.close();
    }
});

test("tools/list without schema cache returns mcp.toolSchemaUnavailable", async () => {
    const harness = createWorkerHarness({ hasToolSchemaCache: false, ready: false, tools: [] });
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(server.url, await readFixture("mcp-tools-list.json"), session.headers);

        assert.equal(response.status, 200);
        assert.equal(response.body.error?.data?.code, "mcp.toolSchemaUnavailable");
    } finally {
        await server.close();
        await binding.close();
    }
});

test("tools/call still maps not ready to mcp.instanceNotReady", async () => {
    const binding = createBinding(createWorkerHarness({ ready: false }));
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(server.url, await readFixture("mcp-tools-call.json"), session.headers);

        assert.equal(response.status, 200);
        assert.equal(response.body.error?.data?.code, "mcp.instanceNotReady");
    } finally {
        await server.close();
        await binding.close();
    }
});

function createBinding(harness = createWorkerHarness()): McpEndpointBinding {
    return new McpEndpointBinding(
        new McpEndpointWorker({
            policy: { capabilities: ["execute"], groups: ["bash"] },
            instanceName: "demo",
            worker: harness.worker
        })
    );
}

async function createBindingServer(binding: McpEndpointBinding) {
    const server = createServer((request, response) => {
        void handleRequest(binding, request, response);
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");

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
        url: `http://127.0.0.1:${address.port}/mcp`
    };
}

async function handleRequest(binding: McpEndpointBinding, request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body = chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue);
    await binding.handleRequest(request, response, body);
}

async function initialize(url: string): Promise<{ headers: Record<string, string> }> {
    const response = await postJson(url, await readFixture("mcp-initialize.json"));
    assert.equal(response.status, 200);
    const sessionId = response.headers.get("mcp-session-id");
    assert.equal(typeof sessionId, "string");

    const headers = {
        "mcp-protocol-version": String(response.body.result?.protocolVersion ?? ""),
        "mcp-session-id": sessionId
    };
    const initialized = await postRawJson(
        url,
        {
            jsonrpc: "2.0",
            method: "notifications/initialized"
        },
        headers
    );

    assert.equal(initialized.status, 202);
    return { headers };
}

async function postJson(url: string, body: JsonValue, extraHeaders?: Record<string, string>) {
    const response = await postRawJson(url, body, extraHeaders);

    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: JSON.parse(response.text) as Record<string, any>,
        headers: response.headers,
        status: response.status
    };
}

async function postRawJson(url: string, body: JsonValue, extraHeaders?: Record<string, string>) {
    const response = await fetch(url, {
        body: JSON.stringify(body),
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...extraHeaders
        },
        method: "POST"
    });

    return {
        headers: response.headers,
        text: await response.text(),
        status: response.status
    };
}

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(await readFile(resolve(fixturesDirectory, name), "utf8")) as JsonValue;
}

function createWorkerHarness(options?: {
    hasToolSchemaCache?: boolean;
    ready?: boolean;
    result?: CommandResult;
    tools?: ToolDefinition[];
}) {
    const calls: Array<{ input: JsonValue; toolName: string }> = [];
    const events: Array<{ data: Record<string, JsonValue>; type: string }> = [];
    const tools = options?.tools ?? [
        { requiredCapabilities: ["execute"] as const, group: "bash", name: "bash_run", description: "Run shell", inputSchema: { type: "object", properties: { command: { type: "string" } } }, outputSchema: { type: "object" } },
        { requiredCapabilities: ["read"] as const, name: "read_logs", description: "Read logs", inputSchema: { type: "object" }, outputSchema: { type: "object" } }
    ];
    const hasToolSchemaCache = options?.hasToolSchemaCache ?? true;
    const ready = options?.ready ?? true;
    const result = options?.result ?? { exitCode: 0, stderr: "", stdout: "/workspace\n" };

    return {
        calls: calls as Array<{
            input: JsonValue;
            requestId?: string;
            sessionId?: string;
            source?: string;
            toolName: string;
        }>,
        events,
        worker: {
            async appendMcpSessionClosed(sessionId: string) {
                events.push({ data: { sessionId }, type: "mcp.sessionClosed" });
            },
            async appendMcpSessionOpened(sessionId: string) {
                events.push({ data: { sessionId }, type: "mcp.sessionOpened" });
            },
            async appendMcpToolCalled(toolName: string, context: { requestId?: string; sessionId?: string }) {
                events.push({
                    data: {
                        requestId: context.requestId ?? null,
                        sessionId: context.sessionId ?? null,
                        source: "mcp",
                        toolName
                    },
                    type: "mcp.toolCalled"
                });
            },
            hasToolSchemaCache() {
                return hasToolSchemaCache;
            },
            snapshot() {
                return { ready };
            },
            listTools() {
                return tools;
            },
            async callTool(toolName: string, input: JsonValue, context: { requestId?: string; sessionId?: string; source: string }) {
                if (!ready) {
                    const error = new Error("not ready");
                    Object.assign(error, {
                        code: "core.instanceNotReady",
                        details: { toolName },
                        retryable: false
                    });
                    throw error;
                }

                calls.push({ toolName, input, ...context });
                return result;
            }
        }
    } as const;
}
