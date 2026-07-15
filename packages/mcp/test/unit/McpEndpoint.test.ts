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

test("session close does not release context-owned worker tool state", async () => {
    const harness = createWorkerHarness();
    const released: string[] = [];
    const endpoint = new McpEndpointWorker({
        gateway: {
            async closeToolSession(sessionId: string) {
                released.push(sessionId);
            }
        } as never,
        instanceName: "demo-local",
        policy: { capabilities: ["read"], groups: ["file"] },
        worker: harness.worker
    });

    await endpoint.appendSessionClosed("session-routed");

    assert.deepEqual(released, []);
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
        assert.deepEqual(response.body.result?.tools.map((tool: { name: string }) => tool.name), ["environ_info", "bash_run"]);
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
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(server.url, withToolContext(await readFixture("mcp-tools-call.json"), ctxId), session.headers);

        assert.equal(response.status, 200);
        assert.equal(harness.calls.length, 1);
        assert.deepEqual(harness.calls[0]?.input, { command: "pwd" });
        assert.equal(harness.calls[0]?.requestId, "req-tools-call");
        assert.equal(harness.calls[0]?.ctxId, ctxId);
        assert.equal(harness.calls[0]?.source, "mcp");
        assert.equal(harness.calls[0]?.toolName, "bash_run");
        assert.deepEqual(harness.events.map((event) => event.type), ["mcp.sessionOpened", "mcp.toolCalled", "mcp.toolCalled"]);
        assert.deepEqual(harness.events[2]?.data, {
            ctxId,
            requestId: "req-tools-call",
            source: "mcp",
            toolName: "bash_run"
        });
        assert.equal(response.body.result?.isError, false);
    } finally {
        await server.close();
        await binding.close();
    }
});

test("notifications/cancelled aborts an in-flight tools/call handler", async () => {
    let observedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const harness = createWorkerHarness({
        async callHandler(_toolName, _input, _context, signal) {
            observedSignal = signal;
            markStarted();
            return await new Promise<CommandResult>((_resolve, reject) => {
                const onAbort = () => {
                    const error = new Error("client timeout");
                    Object.assign(error, {
                        code: "core.toolCallCancelled",
                        retryable: true
                    });
                    reject(error);
                };
                if (signal?.aborted === true) {
                    onAbort();
                    return;
                }
                signal?.addEventListener("abort", onAbort, { once: true });
            });
        }
    });
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const requestController = new AbortController();
        const pendingCall = fetch(server.url, {
            body: JSON.stringify({
                id: "req-cancel-tool",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    arguments: { command: "sleep 30", ctxId },
                    name: "bash_run"
                }
            }),
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                ...session.headers
            },
            method: "POST",
            signal: requestController.signal
        }).catch(() => undefined);

        await started;
        const cancelled = await postRawJson(
            server.url,
            {
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: {
                    reason: "client timeout",
                    requestId: "req-cancel-tool"
                }
            },
            session.headers
        );
        assert.equal(cancelled.status, 202);
        await waitFor(() => observedSignal?.aborted === true);
        assert.equal(observedSignal?.reason, "client timeout");

        requestController.abort();
        await pendingCall;
    } finally {
        await server.close();
        await binding.close();
    }
});

test("closing the HTTP request aborts an in-flight tools/call handler", async () => {
    let observedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const harness = createWorkerHarness({
        async callHandler(_toolName, _input, _context, signal) {
            observedSignal = signal;
            markStarted();
            return await new Promise<CommandResult>((_resolve, reject) => {
                const onAbort = () => reject(new Error("request disconnected"));
                if (signal?.aborted === true) {
                    onAbort();
                    return;
                }
                signal?.addEventListener("abort", onAbort, { once: true });
            });
        }
    });
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const requestController = new AbortController();
        const pendingCall = fetch(server.url, {
            body: JSON.stringify({
                id: "req-disconnect-tool",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    arguments: { command: "sleep 30", ctxId },
                    name: "bash_run"
                }
            }),
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                ...session.headers
            },
            method: "POST",
            signal: requestController.signal
        }).catch(() => undefined);

        await started;
        requestController.abort("gateway timeout");
        await pendingCall;
        await waitFor(() => observedSignal?.aborted === true);
        assert.equal(observedSignal?.reason, "MCP HTTP response closed before completion");
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
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(
            server.url,
            {
                id: "req-instance-list",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    arguments: { ctxId },
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
        assert.deepEqual(response.body.result?.tools.map((tool: { name: string }) => tool.name), ["environ_info", "bash_run"]);
    } finally {
        await server.close();
        await binding.close();
    }
});

test("tools/list without worker schema still exposes environ_info", async () => {
    const harness = createWorkerHarness({ hasToolSchemaCache: false, ready: false, tools: [] });
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(server.url, await readFixture("mcp-tools-list.json"), session.headers);

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.result?.tools.map((tool: { name: string }) => tool.name), ["environ_info"]);
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
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(server.url, withToolContext(await readFixture("mcp-tools-call.json"), ctxId), session.headers);

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

async function createContext(url: string, headers: Record<string, string>): Promise<string> {
    const response = await postJson(url, {
        id: `req-environ-${Date.now()}`,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "environ_info" }
    }, headers);
    const ctxId = response.body.result?.structuredContent?.ctxId;
    assert.equal(typeof ctxId, "string");
    return ctxId;
}

function withToolContext(body: JsonValue, ctxId: string): JsonValue {
    const request = structuredClone(body) as {
        params?: { arguments?: Record<string, JsonValue> };
    };
    request.params ??= {};
    request.params.arguments = { ...(request.params.arguments ?? {}), ctxId };
    return request as JsonValue;
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
    callHandler?: (
        toolName: string,
        input: JsonValue,
        context: { ctxId?: string; requestId?: string; source: string },
        signal?: AbortSignal
    ) => Promise<CommandResult>;
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
            ctxId?: string;
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
            async appendMcpToolCalled(toolName: string, context: { ctxId?: string; requestId?: string }) {
                events.push({
                    data: {
                        requestId: context.requestId ?? null,
                        ctxId: context.ctxId ?? null,
                        source: "mcp",
                        toolName
                    },
                    type: "mcp.toolCalled"
                });
            },
            handshake: {
                instance: "demo",
                workspace: "/workspace",
                platform: {
                    arch: "x86_64",
                    distribution: { id: "arch", name: "Arch Linux", version: "rolling" },
                    os: "linux",
                    packageManager: "pacman",
                    shell: { executable: "/bin/bash", kind: "bash", version: "5" }
                }
            },
            workspacePath: "/workspace",
            hasToolSchemaCache() {
                return hasToolSchemaCache;
            },
            snapshot() {
                return { ready };
            },
            listTools() {
                return tools;
            },
            async callTool(
                toolName: string,
                input: JsonValue,
                context: { ctxId?: string; requestId?: string; source: string },
                signal?: AbortSignal
            ) {
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
                return options?.callHandler === undefined
                    ? result
                    : await options.callHandler(toolName, input, context, signal);
            }
        }
    } as const;
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("condition was not reached");
}
