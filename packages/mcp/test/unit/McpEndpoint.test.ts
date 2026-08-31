import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { requireTcpPort } from "../../../../test/TestHttpSupport.ts";
import { parseMcpHttpResponse } from "../TestMcpHttpResponse.ts";

import {
    McpContextRegistry,
    McpEndpointBinding,
    McpEndpointWorker,
    McpNativeToolResult,
    workspaceAppLegacyResourceUris,
    workspaceAppResourceMeta,
    workspaceAppResourceUri,
    workspaceAppStableResourceUri,
    type McpInstanceGateway,
} from "@portable-devshell/mcp/testing";

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

type CommandResult = {
    exitCode: number | null;
    stderr: string;
    stdout: string;
} & Record<string, JsonValue>;

function structuredResult<T>(result: JsonValue | McpNativeToolResult): T {
    return (result instanceof McpNativeToolResult ? result.structuredContent : result) as T;
}

interface ToolDefinition {
    group: string;
    requiredCapabilities: readonly ("read" | "write" | "execute" | "manage")[];
    description: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
}

test("initialize succeeds over SDK transport", async () => {
    const binding = createBinding(createWorkerHarness(), { serverVersion: "9.8.7" });
    const server = await createBindingServer(binding);

    try {
        const response = await postJson(server.url, await readFixture("mcp-initialize.json"));

        assert.equal(response.status, 200);
        assert.equal(typeof response.body.result?.protocolVersion, "string");
        assert.equal(response.body.result?.serverInfo?.name, "portable-devshell-mcp");
        assert.equal(response.body.result?.serverInfo?.version, "9.8.7");
        assert.equal(response.headers.get("mcp-session-id"), null);
    } finally {
        await server.close();
    }
});

test("tool descriptors advertise endpoint authentication schemes", () => {
    const harness = createWorkerHarness();
    const base = {
        instanceName: "demo",
        policy: { capabilities: ["execute"] as const, groups: ["bash"] },
        worker: harness.worker,
    };

    const noauth = new McpEndpointWorker(base).listTools().find((tool) => tool.name === "bash_run");
    assert.deepEqual(noauth?.securitySchemes, [{ type: "noauth" }]);
    assert.deepEqual((noauth?._meta as { securitySchemes?: JsonValue })?.securitySchemes, [{ type: "noauth" }]);

    const oauth = new McpEndpointWorker({
        ...base,
        auth: {
            enabled: true,
            oauth2: { requiredScopes: ["repo:read", "repo:write"], resourceName: "portable-devshell" },
            provider: "oauth2",
        },
    }).listTools().find((tool) => tool.name === "bash_run");
    const oauthSchemes = [{ type: "oauth2", scopes: ["repo:read", "repo:write"] }];
    assert.deepEqual(oauth?.securitySchemes, oauthSchemes);
    assert.deepEqual((oauth?._meta as { securitySchemes?: JsonValue })?.securitySchemes, oauthSchemes);

    const token = new McpEndpointWorker({
        ...base,
        auth: { enabled: true, provider: "token", token: "0123456789abcdef0123456789abcdef" },
    }).listTools().find((tool) => tool.name === "bash_run");
    assert.equal(token?.securitySchemes, undefined);
    assert.equal((token?._meta as { securitySchemes?: JsonValue } | undefined)?.securitySchemes, undefined);
});

test("HTTP tools/list keeps Workspace actions app-only while advertising host auth metadata", async () => {
    const harness = createWorkerHarness({ tools: [] });
    const unused = async () => { throw new Error("unused"); };
    const gateway = {
        consumeWait: unused,
        createWait: unused,
        decideApproval: unused,
        detachWait: unused,
        listApprovals: async () => [],
        listTools: () => [],
        listWaits: async () => [],
        resolveWait: unused,
        waitForWait: unused,
    } as unknown as McpInstanceGateway;
    const binding = new McpEndpointBinding(new McpEndpointWorker({
        gateway,
        instanceName: "demo",
        policy: { capabilities: [], groups: ["workspace"] },
        worker: harness.worker,
    }));
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(server.url, await readFixture("mcp-tools-list.json"), session.headers);
        assert.equal(response.status, 200);
        const tools = response.body.result?.tools as Array<{
            _meta?: Record<string, JsonValue>;
            name?: string;
            securitySchemes?: JsonValue;
        }> | undefined;
        const answer = tools?.find((tool) => tool.name === "workspace_question_answer");
        const environment = tools?.find((tool) => tool.name === "environ_info");
        const open = tools?.find((tool) => tool.name === "workspace_open");
        assert.notEqual(environment, undefined);
        assert.equal(environment?._meta?.["openai/outputTemplate"], workspaceAppResourceUri);
        assert.deepEqual((environment?._meta?.ui as { visibility?: JsonValue } | undefined)?.visibility, ["model", "app"]);
        assert.notEqual(answer, undefined);
        assert.deepEqual(answer?._meta?.ui, { visibility: ["app"] });
        assert.equal(answer?._meta?.["openai/visibility"], "private");
        assert.equal(answer?._meta?.["openai/widgetAccessible"], true);
        assert.deepEqual(answer?.securitySchemes, [{ type: "noauth" }]);
        assert.deepEqual(answer?._meta?.securitySchemes, [{ type: "noauth" }]);
        assert.notEqual(open, undefined);
        assert.deepEqual((open?._meta?.ui as { visibility?: JsonValue } | undefined)?.visibility, ["model", "app"]);
        assert.deepEqual(open?.securitySchemes, [{ type: "noauth" }]);
        assert.deepEqual(open?._meta?.securitySchemes, [{ type: "noauth" }]);
    } finally {
        await server.close();
    }
});

test("tmux_run does not render a Workspace App", () => {
    const harness = createWorkerHarness({
        tools: [{
            description: "Run one tmux task",
            group: "tmux",
            inputSchema: { type: "object" },
            name: "tmux_run",
            outputSchema: { type: "object" },
            requiredCapabilities: [],
        }]
    });
    const tool = new McpEndpointWorker({
        instanceName: "demo",
        policy: { capabilities: [] as const, groups: ["tmux"] },
        worker: harness.worker,
    }).listTools().find((entry) => entry.name === "tmux_run");
    const meta = tool?._meta as Record<string, JsonValue> | undefined;

    assert.equal(meta?.["openai/outputTemplate"], undefined);
    assert.equal(meta?.["openai/widgetAccessible"], undefined);
    assert.equal(meta?.["ui/resourceUri"], undefined);
    assert.equal((meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, undefined);
    assert.equal(meta?.["openai/toolInvocation/invoking"], undefined);
});

test("Workspace MCP App renders from a versioned URI while keeping the stable reader alias", async () => {
    const binding = createBinding();
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const listed = await postJson(server.url, {
            id: "req-resources-list",
            jsonrpc: "2.0",
            method: "resources/list",
            params: {}
        }, session.headers);
        assert.equal(listed.status, 200);
        assert.deepEqual(listed.body.result?.resources?.map((resource: { mimeType?: string; uri?: string }) => ({
            mimeType: resource.mimeType,
            uri: resource.uri
        })), [{
            mimeType: "text/html;profile=mcp-app",
            uri: workspaceAppResourceUri
        }]);
        assert.notEqual(workspaceAppResourceUri, workspaceAppStableResourceUri);

        const read = await postJson(server.url, {
            id: "req-resource-read",
            jsonrpc: "2.0",
            method: "resources/read",
            params: { uri: workspaceAppStableResourceUri }
        }, session.headers);
        assert.equal(read.status, 200);
        assert.equal(read.body.result?.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
        assert.equal(read.body.result?.contents?.[0]?.uri, workspaceAppStableResourceUri);
        assert.deepEqual(read.body.result?.contents?.[0]?._meta, workspaceAppResourceMeta);
        assert.deepEqual(workspaceAppLegacyResourceUris, [
            "ui://portable-devshell/workspace-651c9d0f1042c493.html",
            "ui://portable-devshell/workspace-98410baf51f694b0.html",
            "ui://portable-devshell/workspace-03c4911b6d185e3c.html",
            "ui://portable-devshell/workspace-c978585dba4e38c7.html",
            "ui://portable-devshell/workspace-4305d70d5fdb6a12.html"
        ]);
        for (const [index, uri] of workspaceAppLegacyResourceUris.entries()) {
            const legacy = await postJson(server.url, {
                id: `req-resource-read-legacy-${index}`,
                jsonrpc: "2.0",
                method: "resources/read",
                params: { uri }
            }, session.headers);
            assert.equal(legacy.status, 200);
            assert.equal(legacy.body.result?.contents?.[0]?.uri, uri);
            assert.equal(legacy.body.result?.contents?.[0]?.text, read.body.result?.contents?.[0]?.text);
            assert.deepEqual(legacy.body.result?.contents?.[0]?._meta, workspaceAppResourceMeta);
        }
    } finally {
        await server.close();
    }
});

test("Workspace MCP App uses the configured public origin as its ChatGPT component domain", async () => {
    const binding = createBinding(createWorkerHarness(), {
        publicBaseUrl: "https://devshell.example.com/prefix",
    });
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const read = await postJson(server.url, {
            id: "req-resource-domain",
            jsonrpc: "2.0",
            method: "resources/read",
            params: { uri: workspaceAppResourceUri }
        }, session.headers);
        assert.equal(read.status, 200);
        assert.deepEqual(read.body.result?.contents?.[0]?._meta, {
            ...workspaceAppResourceMeta,
            ui: {
                ...workspaceAppResourceMeta.ui,
                csp: {
                    connectDomains: ["https://devshell.example.com"],
                    resourceDomains: [],
                },
                domain: "https://devshell.example.com",
            },
            "openai/widgetCSP": {
                connect_domains: ["https://devshell.example.com"],
                resource_domains: [],
            },
            "openai/widgetDomain": "https://devshell.example.com",
        });
    } finally {
        await server.close();
    }
});

test("Workspace MCP App does not advertise a wildcard listener as its component domain", async () => {
    for (const publicBaseUrl of ["http://0.0.0.0:17890", "http://[::]:17890"]) {
        const binding = createBinding(createWorkerHarness(), { publicBaseUrl });
        const server = await createBindingServer(binding);
        try {
            const session = await initialize(server.url);
            const read = await postJson(server.url, {
                id: `req-resource-wildcard-${publicBaseUrl}`,
                jsonrpc: "2.0",
                method: "resources/read",
                params: { uri: workspaceAppResourceUri }
            }, session.headers);
            assert.equal(read.status, 200);
            assert.deepEqual(read.body.result?.contents?.[0]?._meta, workspaceAppResourceMeta);
        } finally {
            await server.close();
        }
    }
});

test("stateless endpoint serves every request without sessions", async () => {
    const harness = createWorkerHarness();
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const staleHeaders = { "mcp-session-id": "stale-session" };
        const initializeResponse = await postJson(server.url, await readFixture("mcp-initialize.json"), staleHeaders);
        assert.equal(initializeResponse.status, 200);
        assert.equal(initializeResponse.headers.get("mcp-session-id"), null);

        const listResponse = await postJson(server.url, {
            id: "req-stateless-tools-list",
            jsonrpc: "2.0",
            method: "tools/list",
            params: {}
        }, staleHeaders);
        assert.equal(listResponse.status, 200);
        assert.ok(Array.isArray(listResponse.body.result?.tools));

        assert.deepEqual(harness.events.map((event) => event.type), []);
    } finally {
        await server.close();
    }
});

test("tools/list uses group and capability filtering", async () => {
    const binding = createBinding();
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(server.url, await readFixture("mcp-tools-list.json"), session.headers);

        assert.equal(response.status, 200);
        const listedTools = response.body.result?.tools ?? [];
        const names = listedTools.map((tool: { name: string }) => tool.name);
        assert.equal(names.includes("bash_run"), true);
        assert.equal(names.includes("read_logs"), false);
        const bashTool = listedTools.find((tool: { name: string }) => tool.name === "bash_run") as {
            _meta?: { securitySchemes?: unknown };
            securitySchemes?: unknown;
        } | undefined;
        assert.deepEqual(bashTool?.securitySchemes, [{ type: "noauth" }]);
        assert.deepEqual(bashTool?._meta?.securitySchemes, [{ type: "noauth" }]);
    } finally {
        await server.close();
    }
});

test("cached removed tool recipients return a structured tombstone over MCP", async () => {
    const binding = createBinding();
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const listed = await postJson(server.url, await readFixture("mcp-tools-list.json"), session.headers);
        const names = listed.body.result?.tools.map((tool: { name: string }) => tool.name) ?? [];
        assert.equal(names.includes("context_message_read"), false);

        const response = await postJson(server.url, {
            id: "req-stale-tool",
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
                arguments: {},
                name: "context_message_read",
            }
        }, session.headers);

        assert.equal(response.status, 200);
        assert.equal(response.body.error, undefined);
        assert.equal(response.body.result?.isError, false);
        assert.match(response.body.result?.content?.[0]?.text ?? "", /Cached tool context_message_read was removed/);
        assert.equal(response.body.result?.structuredContent?.staleToolSnapshot?.name, "context_message_read");
        assert.equal(response.body.result?.structuredContent?.staleToolSnapshot?.replacement, undefined);
    } finally {
        await server.close();
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
        assert.deepEqual(harness.events.map((event) => event.type), ["mcp.toolCalled", "mcp.toolCalled"]);
        assert.deepEqual(harness.events[1]?.data, {
            ctxId,
            requestId: "req-tools-call",
            source: "mcp",
            toolName: "bash_run"
        });
        assert.equal(response.body.result?.isError, false);
        assert.deepEqual(response.body.result?.content, []);
        assert.deepEqual(response.body.result?.structuredContent, {
            exitCode: 0,
            stderr: "",
            stdout: "/workspace\n"
        });
    } finally {
        await server.close();
    }
});

test("tools/call returns a structured hint when the tool fails", async () => {
    const harness = createWorkerHarness({
        async callHandler() {
            throw new Error("command failed");
        }
    });
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(
            server.url,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            session.headers
        );

        assert.equal(response.status, 200);
        const comments = response.body.error?.data?.comment as string[];
        assert.match(comments[0] ?? "", /^\[error\.unknown\] /);
    } finally {
        await server.close();
    }
});

test("tools/call appends a worker result hint and keeps the flat shape", async () => {
    const harness = createWorkerHarness({
        result: { exitCode: 7, stderr: "boom", stdout: "", termination: "exited" }
    });
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(
            server.url,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            session.headers
        );

        assert.equal(response.status, 200);
        const structured = response.body.result?.structuredContent;
        assert.equal(structured?.exitCode, 7);
        assert.equal(structured?.stderr, "boom");
        assert.equal(structured?.result, undefined);
        assert.match(structured?.comment?.[0] ?? "", /^\[bash\.nonZeroExit\] /);
        for (const entry of structured?.comment as string[]) {
            assert.equal(entry.includes("boom"), false);
        }
    } finally {
        await server.close();
    }
});

test("environment and control-owned tools execute through the endpoint audit path", async () => {
    const harness = createWorkerHarness();
    const gateway = {
        assertReady() {},
        async callTool() {
            return {};
        },
        async createSshInstance() {
            return {};
        },
        async listInstances() {
            return [{ name: "demo-local" }];
        },
        async readTodo() {
            return { revision: 1, todos: [] };
        },
        listTools() {
            return [];
        },
        async shareArtifact(
            _defaultInstance: string,
            input: { path?: string },
        ) {
            return {
                ...(input.path === undefined ? {} : { path: input.path }),
                shareId: "share-1",
            };
        },
        async transferArtifact() {
            return {};
        },
        async connectInstance() {
            return {};
        },
        async statusInstance() {
            return {};
        },
        async stopInstance() {
            return {};
        },
        async writeTodo() {
            return {};
        },
    } as unknown as McpInstanceGateway;
    const endpoint = new McpEndpointWorker({
        gateway,
        instanceName: "demo-local",
        policy: {
            capabilities: ["manage", "read", "write"],
            groups: ["artifact", "instance", "todo"],
        },
        worker: harness.worker,
    });
    const requestContext = {
        principal: "test",
        requestId: "request-control-tools",
    };

    const environment = await endpoint.callTool(
        "environ_info",
        { workspace: "/workspace" },
        requestContext,
    );
    const ctxId = String(structuredResult<{ ctxId?: string }>(environment).ctxId);
    await endpoint.callTool("todo_read", { ctxId }, requestContext);
    await endpoint.callTool("instance_list", { ctxId }, requestContext);
    await endpoint.callTool(
        "artifact_share",
        { ctxId, path: "./result.txt" },
        requestContext,
    );

    assert.deepEqual(
        harness.auditedCalls.map((call) => ({
            ctxId: call.context.ctxId,
            input: call.input,
            requestId: call.context.requestId,
            source: call.context.source,
            toolName: call.toolName,
        })),
        [
            {
                ctxId,
                input: {},
                requestId: "request-control-tools",
                source: "mcp",
                toolName: "environ_info",
            },
            {
                ctxId,
                input: {},
                requestId: "request-control-tools",
                source: "mcp",
                toolName: "todo_read",
            },
            {
                ctxId,
                input: {},
                requestId: "request-control-tools",
                source: "mcp",
                toolName: "instance_list",
            },
            {
                ctxId,
                input: { path: "./result.txt" },
                requestId: "request-control-tools",
                source: "mcp",
                toolName: "artifact_share",
            },
        ],
    );
});

test("explicit context mode exposes ctxId and does not bind authority to OpenAI session metadata", async () => {
    const harness = createWorkerHarness();
    const endpoint = new McpEndpointWorker({
        instanceName: "demo",
        policy: { capabilities: ["execute"], groups: ["bash"] },
        worker: harness.worker,
    });
    const bashTool = endpoint
        .listTools()
        .find((tool) => tool.name === "bash_run");
    assert.notEqual(bashTool, undefined);
    assert.notEqual(
        (bashTool?.inputSchema as { properties?: Record<string, unknown> })
            .properties?.ctxId,
        undefined,
    );
    const environmentTool = endpoint
        .listTools()
        .find((tool) => tool.name === "environ_info");
    assert.notEqual(
        (
            environmentTool?.outputSchema as {
                properties?: Record<string, unknown>;
            }
        ).properties?.ctxId,
        undefined,
    );

    const requestContext = {
        principal: "subject-1",
        requestMeta: { "openai/session": "chat-session-1" },
        requestId: "request-session-mode",
    };
    const environment = await endpoint.callTool(
        "environ_info",
        { workspace: "/workspace" },
        requestContext,
    );
    const ctxIdValue = structuredResult<{ ctxId?: unknown }>(environment).ctxId;
    assert.equal(typeof ctxIdValue, "string");
    const ctxId = ctxIdValue as string;

    await endpoint.callTool(
        "bash_run",
        { command: "pwd", ctxId },
        {
            ...requestContext,
            requestMeta: { "openai/session": "chat-session-2" },
        },
    );
    assert.equal(harness.calls[0]?.ctxId, ctxId);
    assert.deepEqual(harness.calls[0]?.input, { command: "pwd" });

    await assert.rejects(
        endpoint.callTool("bash_run", { command: "pwd" }, requestContext),
        (error: unknown) =>
            (error as { code?: string }).code === "mcp.contextInvalid",
    );
});

test("explicit context mode ignores OpenAI session metadata unless ctxId is supplied", async () => {
    const harness = createWorkerHarness();
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const meta = { "openai/session": "chat-http-1" };
        const environment = await postJson(
            server.url,
            {
                id: "req-session-environ",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    _meta: meta,
                    arguments: { workspace: "/workspace" },
                    name: "environ_info",
                },
            },
            session.headers,
        );
        assert.equal(environment.status, 200);
        const ctxId = environment.body.result?.structuredContent?.ctxId;
        assert.equal(typeof ctxId, "string");

        const run = await postJson(
            server.url,
            {
                id: "req-session-run",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    _meta: meta,
                    arguments: { command: "pwd", ctxId },
                    name: "bash_run",
                },
            },
            session.headers,
        );
        assert.equal(run.status, 200);
        assert.equal(run.body.error, undefined, JSON.stringify(run.body));
        assert.equal(harness.calls[0]?.ctxId, ctxId);
        assert.deepEqual(harness.calls[0]?.input, { command: "pwd" });

        const missingContext = await postJson(
            server.url,
            {
                id: "req-session-missing-context",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    _meta: meta,
                    arguments: { command: "pwd" },
                    name: "bash_run",
                },
            },
            session.headers,
        );
        assert.notEqual(missingContext.body.error, undefined);
    } finally {
        await server.close();
    }
});

test("OpenAI session binding resolves one internal ctxId without making models carry it", async () => {
    const harness = createWorkerHarness();
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-openai-stable",
    });
    await registry.initialize();
    const endpoint = new McpEndpointWorker({
        contextMode: "openai-session",
        contextRegistry: registry,
        instanceName: "demo",
        policy: { capabilities: ["execute"], groups: ["bash"] },
        worker: harness.worker,
    });
    const requestContext = {
        principal: "subject-1",
        requestMeta: { "openai/session": "chat-session-stable" },
        requestId: "request-openai-session",
    };

    const bashTool = endpoint
        .listTools()
        .find((tool) => tool.name === "bash_run");
    const bashSchema = bashTool?.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
    };
    assert.notEqual(bashSchema.properties?.ctxId, undefined);
    assert.equal(bashSchema.required?.includes("ctxId") ?? false, false);
    const first = structuredResult<{ ctxId: string; status: string; workspace: string }>(await endpoint.callTool(
        "environ_info",
        { workspace: "/workspace/one" },
        requestContext,
    ));
    const second = structuredResult<{ ctxId: string; status: string; workspace: string }>(await endpoint.callTool(
        "environ_info",
        { workspace: "/workspace/two" },
        requestContext,
    ));

    assert.equal(first.ctxId, "ctx-openai-stable");
    assert.equal(first.workspace, "/workspace/one");
    assert.equal(second.ctxId, first.ctxId);
    assert.equal(second.status, "active");
    assert.equal(second.workspace, "/workspace/two");
    assert.equal(endpoint.listTools().some((tool) => tool.name === "context_acquire"), false);
    assert.equal(endpoint.listTools().some((tool) => tool.name === "context_renew"), false);

    await endpoint.callTool("bash_run", { command: "pwd" }, requestContext);
    assert.equal(harness.calls[0]?.ctxId, first.ctxId);
    assert.deepEqual(harness.calls[0]?.input, { command: "pwd" });

    await endpoint.callTool(
        "bash_run",
        { command: "pwd", ctxId: first.ctxId },
        {
            ...requestContext,
            requestMeta: { "openai/session": "another-session" },
        },
    );
    assert.equal(harness.calls[1]?.ctxId, first.ctxId);
});

test("expired OpenAI session binding renews the same ctxId on ordinary activity", async () => {
    let now = 1_000;
    const harness = createWorkerHarness();
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-openai-renew",
        now: () => now,
        ttlMs: 100,
    });
    await registry.initialize();
    const endpoint = new McpEndpointWorker({
        contextMode: "openai-session",
        contextRegistry: registry,
        instanceName: "demo",
        policy: { capabilities: ["execute"], groups: ["bash"] },
        worker: harness.worker,
    });
    const requestContext = {
        principal: "subject-1",
        requestMeta: { "openai/session": "chat-session-renew" },
        requestId: "request-openai-renew",
    };

    const acquired = structuredResult<{ ctxId: string; status: string }>(await endpoint.callTool(
        "environ_info",
        { workspace: "/workspace" },
        requestContext,
    ));
    assert.equal(acquired.ctxId, "ctx-openai-renew");

    now = 1_101;
    await endpoint.callTool("bash_run", { command: "pwd" }, requestContext);
    assert.equal(harness.calls.at(-1)?.ctxId, acquired.ctxId);
    const renewed = await registry.lookup(acquired.ctxId, { principal: "subject-1" });
    assert.equal(renewed.status, "active");
});

test("disabled OpenAI session binding reacquires a new Context and moves the binding", async () => {
    const ids = ["ctx-openai-disabled", "ctx-openai-replacement"];
    const harness = createWorkerHarness();
    const registry = new McpContextRegistry({ idFactory: () => ids.shift() ?? "ctx-unexpected" });
    await registry.initialize();
    const endpoint = new McpEndpointWorker({
        contextMode: "openai-session",
        contextRegistry: registry,
        instanceName: "demo",
        policy: { capabilities: ["execute"], groups: ["bash"] },
        worker: harness.worker,
    });
    const requestContext = {
        principal: "subject-1",
        requestMeta: { "openai/session": "chat-session-disabled" },
        requestId: "request-openai-disabled",
    };

    const first = structuredResult<{ ctxId: string; status: string }>(await endpoint.callTool(
        "environ_info",
        { workspace: "/workspace/old" },
        requestContext,
    ));
    assert.equal(first.ctxId, "ctx-openai-disabled");
    await registry.disable(first.ctxId);

    await assert.rejects(
        endpoint.callTool("bash_run", { command: "pwd" }, requestContext),
        (error: unknown) =>
            (error as { code?: string }).code === "mcp.contextDisabled",
    );

    const replacement = structuredResult<{ ctxId: string; status: string; workspace: string }>(await endpoint.callTool(
        "environ_info",
        { workspace: "/workspace/new" },
        requestContext,
    ));
    assert.equal(replacement.ctxId, "ctx-openai-replacement");
    assert.equal(replacement.status, "active");
    assert.equal(replacement.workspace, "/workspace/new");

    const bound = await registry.lookupExternal(
        { kind: "openai/session", value: "chat-session-disabled" },
        { principal: "subject-1" },
    );
    assert.equal(bound?.ctxId, replacement.ctxId);
    assert.equal((await registry.lookup(first.ctxId, { principal: "subject-1" })).status, "disabled");

    await endpoint.callTool("bash_run", { command: "pwd" }, requestContext);
    assert.equal(harness.calls.at(-1)?.ctxId, replacement.ctxId);
});

test("HTTP forwards OpenAI session metadata into the generic Context binding", async () => {
    const harness = createWorkerHarness();
    const binding = createBinding(harness, { contextMode: "openai-session" });
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const meta = { "openai/session": "chat-http-bound" };
        const acquire = async (workspace: string) =>
            await postJson(
                server.url,
                {
                    id: `req-session-acquire-${workspace}`,
                    jsonrpc: "2.0",
                    method: "tools/call",
                    params: {
                        _meta: meta,
                        arguments: { workspace },
                        name: "environ_info",
                    },
                },
                session.headers,
            );

        const first = await acquire("/workspace/one");
        const second = await acquire("/workspace/two");
        const firstCtxId = first.body.result?.structuredContent?.ctxId;
        assert.equal(typeof firstCtxId, "string");
        assert.equal(second.body.result?.structuredContent?.ctxId, firstCtxId);

        const run = await postJson(
            server.url,
            {
                id: "req-session-run-with-binding",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    _meta: meta,
                    arguments: { command: "pwd" },
                    name: "bash_run",
                },
            },
            session.headers,
        );
        assert.equal(run.status, 200);
        assert.equal(run.body.error, undefined, JSON.stringify(run.body));
        assert.equal(harness.calls[0]?.ctxId, firstCtxId);
    } finally {
        await server.close();
    }
});

test("notifications/cancelled is acknowledged without a matching in-flight call", async () => {
    const harness = createWorkerHarness();
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const cancelled = await postRawJson(
            server.url,
            {
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: {
                    reason: "client timeout",
                    requestId: "req-unknown-tool"
                }
            },
            session.headers
        );
        assert.equal(cancelled.status, 202);
        assert.deepEqual(harness.calls, []);
    } finally {
        await server.close();
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
        assert.equal(observedSignal?.reason, "MCP HTTP connection closed before completion");
    } finally {
        await server.close();
    }
});

test("instance_list returns object structured content through SDK transport", async () => {
    const harness = createWorkerHarness({ hasToolSchemaCache: false, ready: false, tools: [] });
    const gateway = {
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
        async readTodo() {
            return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
        },
        listTools() {
            return [];
        },
        async connectInstance() {
            return {};
        },
        async statusInstance() {
            return {};
        },
        async stopInstance() {
            return {};
        },
        async writeTodo() {
            return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
        }
    } as unknown as McpInstanceGateway;
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
    }
});

test("artifact_viewImage returns native image content over SDK transport", async () => {
    const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const harness = createWorkerHarness({ hasToolSchemaCache: false, ready: false, tools: [] });
    const gateway = {
        assertReady() {},
        async callTool() { return {}; },
        async createSshInstance() { return {}; },
        async listInstances() { return []; },
        async readTodo() { return { revision: 0, todos: [] }; },
        listTools() { return []; },
        async connectInstance() { return {}; },
        async statusInstance() { return {}; },
        async stopInstance() { return {}; },
        async viewArtifactImage(defaultInstance: string, input: { path?: string; workspace?: string }) {
            assert.equal(defaultInstance, "demo");
            assert.deepEqual(input, { path: "./pixel.png", workspace: "/workspace" });
            return {
                bytes: 68,
                content: pngData,
                encoding: "base64",
                mediaType: "image/png",
                name: "pixel.png",
                source: { instance: "demo", path: "./pixel.png", type: "file" }
            };
        },
        async writeTodo() { return { revision: 0, todos: [] }; }
    } as unknown as McpInstanceGateway;
    const binding = new McpEndpointBinding(
        new McpEndpointWorker({
            gateway,
            instanceName: "demo",
            policy: { capabilities: ["read"], groups: ["artifact"] },
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
                id: "req-artifact-view-image",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    arguments: { ctxId, path: "./pixel.png" },
                    name: "artifact_viewImage"
                }
            },
            session.headers
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.error, undefined);
        assert.deepEqual(response.body.result?.content, [
            { data: pngData, mimeType: "image/png", type: "image" }
        ]);
        assert.deepEqual(response.body.result?.structuredContent, {
            bytes: 68,
            mediaType: "image/png",
            name: "pixel.png",
            source: { instance: "demo", path: "./pixel.png", type: "file" }
        });
    } finally {
        await server.close();
    }
});

test("tools/list returns cached schema while the instance is not ready", async () => {
    const binding = createBinding(createWorkerHarness({ ready: false }));
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(server.url, await readFixture("mcp-tools-list.json"), session.headers);

        assert.equal(response.status, 200);
        assert.equal(
            response.body.result?.tools.some((tool: { name: string }) => tool.name === "bash_run"),
            true
        );
    } finally {
        await server.close();
    }
});

test("environ_info remains callable without a worker schema", async () => {
    const harness = createWorkerHarness({ hasToolSchemaCache: false, ready: false, tools: [] });
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        assert.equal(typeof ctxId, "string");
    } finally {
        await server.close();
    }
});

test("tools/call still maps not ready to mcp.instanceNotReady", async () => {
    const binding = createBinding(createWorkerHarness({ ready: false }), { readyWaitMs: 50 });
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(server.url, withToolContext(await readFixture("mcp-tools-call.json"), ctxId), session.headers);

        assert.equal(response.status, 200);
        assert.equal(response.body.error?.data?.code, "mcp.instanceNotReady");
    } finally {
        await server.close();
    }
});

test("tools/call waits for a transiently not-ready instance before executing", async () => {
    const pending = { ready: false };
    const harness = createWorkerHarness({ ready: false });
    const worker = harness.worker as unknown as {
        callTool(...args: unknown[]): Promise<unknown>;
        snapshot(): { ready: boolean };
    };
    let invoked = false;
    worker.snapshot = () => ({ ready: pending.ready });
    worker.callTool = async () => {
        invoked = true;
        return { exitCode: 0, stderr: "", stdout: "/workspace\n" };
    };
    const binding = createBinding(harness, { readyWaitMs: 2_000 });
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);

        const call = postJson(
            server.url,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            session.headers
        );

        await new Promise((resolve) => setTimeout(resolve, 100));
        pending.ready = true;

        const response = await call;
        assert.equal(response.status, 200);
        assert.equal(response.body.error, undefined);
        assert.equal(invoked, true);
    } finally {
        await server.close();
    }
});

function createBinding(
    harness = createWorkerHarness(),
    options?: { contextMode?: "explicit" | "openai-session"; publicBaseUrl?: string; readyWaitMs?: number; serverVersion?: string }
): McpEndpointBinding {
    return new McpEndpointBinding(
        new McpEndpointWorker({
            contextMode: options?.contextMode,
            policy: { capabilities: ["execute"], groups: ["bash"] },
            instanceName: "demo",
            readyWaitMs: options?.readyWaitMs,
            worker: harness.worker
        }),
        options?.serverVersion,
        options?.publicBaseUrl,
    );
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
        url: `http://127.0.0.1:${port}/mcp`
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
    assert.equal(response.headers.get("mcp-session-id"), null);

    const headers: Record<string, string> = {
        "mcp-protocol-version": String(response.body.result?.protocolVersion ?? "")
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

async function createContext(url: string, headers: Record<string, string>, workspace = "/workspace"): Promise<string> {
    const response = await postJson(url, {
        id: `req-environ-${Date.now()}`,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { workspace }, name: "environ_info" }
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
        body: parseMcpHttpResponse<Record<string, any>>(response.text),
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
    const auditedCalls: Array<{
        context: { ctxId?: string; requestId?: string; source: string };
        input: JsonValue;
        toolName: string;
    }> = [];
    const calls: Array<{ input: JsonValue; toolName: string }> = [];
    const events: Array<{ data: Record<string, JsonValue>; type: string }> = [];
    const tools: ToolDefinition[] = options?.tools ?? [
        { requiredCapabilities: ["execute"] as const, group: "bash", name: "bash_run", description: "Run shell", inputSchema: { type: "object", properties: { command: { type: "string" } } }, outputSchema: { type: "object" } },
        { requiredCapabilities: ["read"] as const, group: "file", name: "read_logs", description: "Read logs", inputSchema: { type: "object" }, outputSchema: { type: "object" } }
    ];
    const hasToolSchemaCache = options?.hasToolSchemaCache ?? true;
    const ready = options?.ready ?? true;
    const result = options?.result ?? { exitCode: 0, stderr: "", stdout: "/workspace\n" };

    return {
        auditedCalls,
        calls: calls as Array<{
            input: JsonValue;
            requestId?: string;
            ctxId?: string;
            source?: string;
            toolName: string;
        }>,
        events,
        worker: {
            async auditToolCall<T extends JsonValue>(
                toolName: string,
                input: JsonValue,
                context: { ctxId?: string; requestId?: string; source: string },
                operation: (callId: string) => Promise<T>
            ): Promise<T> {
                auditedCalls.push({ context, input, toolName });
                return await operation("call-test");
            },
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
                homeDirectory: "/home/demo",
                instance: "demo",
                skillsDirectory: "/home/demo/.devshell/skill",
                platform: {
                    arch: "x86_64",
                    distribution: { id: "arch", name: "Arch Linux", version: "rolling" },
                    os: "linux",
                    packageManager: "pacman",
                    shell: { executable: "/bin/bash", kind: "bash", version: "5" }
                }
            },
            async prepareWorkspace(workspace: string) {
                return {
                    projectMemoryAgentFile: `${workspace}/.devshell/AGENT.md`,
                    projectMemoryDirectory: `${workspace}/.devshell`,
                    projectMemoryPresent: true,
                    temporaryDirectory: "/tmp/workspace-123456",
                    workspace
                };
            },
            async readAlerts() { return { advice: [] }; },
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
                signal?: AbortSignal,
                transformResult?: (result: JsonValue, callId: string) => Promise<JsonValue>
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
                const toolResult = options?.callHandler === undefined
                    ? result
                    : await options.callHandler(toolName, input, context, signal);
                return transformResult === undefined
                    ? toolResult
                    : await transformResult(toolResult, "call-test");
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
