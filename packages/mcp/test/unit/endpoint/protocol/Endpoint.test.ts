import { asInstanceName } from "@portable-devshell/shared";
import type { ContextRecord, ContextTransport, ToolCallApi } from "@portable-devshell/shared";
import { contextToolDefinitions } from "../../../../../control/src/context/tool/Definition.ts";
import type { ToolCallHookValue } from "@portable-devshell/shared";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { requireTcpPort } from "../../../../../../test/TestHttpSupport.ts";
import { parseMcpHttpResponse } from "../../../TestMcpHttpResponse.ts";

import { attachToolCallErrorPayload } from "@portable-devshell/shared";

import {
    McpEndpointBinding,
    McpExtensionRegistry,
    McpNativeToolResult,
    createMcpAppMcpExtension,
    mcpAppLegacyResourceUris,
    mcpAppResourceMeta,
    mcpAppResourceUri,
    mcpAppStableResourceUri,
} from "@portable-devshell/mcp/testing";
import {
    createTestMcpEndpoint,
} from "../../../ContextRuntime.ts";
import { TestToolSource } from "../../../support/ToolSource.ts";

const fixturesDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../fixtures",
);
type JsonValue =
    | boolean
    | number
    | null
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

type CommandResult = {
    exitCode: number | null;
    stderr: string;
    stdout: string;
} & Record<string, JsonValue>;

function structuredResult<T>(result: JsonValue | McpNativeToolResult): T {
    return (
        result instanceof McpNativeToolResult
            ? result.structuredContent
            : result
    ) as T;
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
    const binding = createBinding(createWorkerHarness(), {
        serverVersion: "9.8.7",
    });
    const server = await createBindingServer(binding);

    try {
        const response = await postJson(
            server.url,
            await readFixture("mcp-initialize.json"),
        );

        assert.equal(response.status, 200);
        assert.equal(typeof response.body.result?.protocolVersion, "string");
        assert.equal(
            response.body.result?.serverInfo?.name,
            "portable-devshell-mcp",
        );
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
        context: harness.context,
        tools: harness.tools,
        toolSource: harness.toolRegistry,
    };

    const noauth = createTestMcpEndpoint(base)
        .listTools()
        .find((tool) => tool.name === "bash_run");
    assert.deepEqual(noauth?.securitySchemes, [{ type: "noauth" }]);
    assert.deepEqual(
        (noauth?._meta as { securitySchemes?: JsonValue })?.securitySchemes,
        [{ type: "noauth" }],
    );

    const oauth = createTestMcpEndpoint({
        ...base,
        auth: {
            enabled: true,
            oauth2: {
                requiredScopes: ["repo:read", "repo:write"],
                resourceName: "portable-devshell",
            },
            provider: "oauth2",
        },
    })
        .listTools()
        .find((tool) => tool.name === "bash_run");
    const oauthSchemes = [
        { type: "oauth2", scopes: ["repo:read", "repo:write"] },
    ];
    assert.deepEqual(oauth?.securitySchemes, oauthSchemes);
    assert.deepEqual(
        (oauth?._meta as { securitySchemes?: JsonValue })?.securitySchemes,
        oauthSchemes,
    );

    const token = createTestMcpEndpoint({
        ...base,
        auth: {
            enabled: true,
            provider: "token",
            token: "0123456789abcdef0123456789abcdef",
        },
    })
        .listTools()
        .find((tool) => tool.name === "bash_run");
    assert.equal(token?.securitySchemes, undefined);
    assert.equal(
        (token?._meta as { securitySchemes?: JsonValue } | undefined)
            ?.securitySchemes,
        undefined,
    );
});

test("tmux_run does not render a Workspace App", () => {
    const harness = createWorkerHarness({
        tools: [
            {
                description: "Run one tmux task",
                group: "tmux",
                inputSchema: { type: "object" },
                name: "tmux_run",
                outputSchema: { type: "object" },
                requiredCapabilities: [],
            },
        ],
    });
    const tool = createTestMcpEndpoint({
        instanceName: "demo",
        context: harness.context,
        tools: harness.tools,
        toolSource: harness.toolRegistry,
    })
        .listTools()
        .find((entry) => entry.name === "tmux_run");
    const meta = tool?._meta as Record<string, JsonValue> | undefined;

    assert.equal(meta?.["openai/outputTemplate"], undefined);
    assert.equal(meta?.["openai/widgetAccessible"], undefined);
    assert.equal(meta?.["ui/resourceUri"], undefined);
    assert.equal(
        (meta?.ui as { resourceUri?: string } | undefined)?.resourceUri,
        undefined,
    );
    assert.equal(meta?.["openai/toolInvocation/invoking"], undefined);
});

test("MCP endpoint serves App resources and environment presentation from a generic Extension contribution", async () => {
    const extensions = new McpExtensionRegistry([
        {
            id: "example",
            presentation: {
                bootstrap: "environment",
                resourceUri: "ui://example/app-v2.html",
            },
            resources: [
                {
                    aliases: ["ui://example/app.html"],
                    app: true,
                    mimeType: "text/html;profile=mcp-app",
                    name: "Example App",
                    read: () => ({
                        _meta: { source: "example" },
                        text: "<html>example</html>",
                    }),
                    uri: "ui://example/app-v2.html",
                },
            ],
        },
    ]);
    const harness = createWorkerHarness();
    const binding = new McpEndpointBinding(
        createTestMcpEndpoint({
            extensions,
            instanceName: "demo",
            context: harness.context,
            tools: harness.tools,
            toolSource: harness.toolRegistry,
        }),
    );
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        assert.deepEqual(
            session.initializeResult?.capabilities?.extensions?.[
                "io.modelcontextprotocol/ui"
            ],
            {},
        );
        const tools = await postJson(
            server.url,
            await readFixture("mcp-tools-list.json"),
            session.headers,
        );
        const environment = (
            tools.body.result?.tools as
                | Array<{ _meta?: Record<string, JsonValue>; name?: string }>
                | undefined
        )?.find((tool) => tool.name === "environ_info");
        assert.equal(
            environment?._meta?.["openai/outputTemplate"],
            "ui://example/app-v2.html",
        );

        const listed = await postJson(
            server.url,
            {
                id: "req-generic-resource-list",
                jsonrpc: "2.0",
                method: "resources/list",
                params: {},
            },
            session.headers,
        );
        assert.deepEqual(listed.body.result?.resources, [
            {
                mimeType: "text/html;profile=mcp-app",
                name: "Example App",
                uri: "ui://example/app-v2.html",
            },
        ]);

        const read = await postJson(
            server.url,
            {
                id: "req-generic-resource-read",
                jsonrpc: "2.0",
                method: "resources/read",
                params: { uri: "ui://example/app.html" },
            },
            session.headers,
        );
        assert.deepEqual(read.body.result?.contents, [
            {
                _meta: { source: "example" },
                mimeType: "text/html;profile=mcp-app",
                text: "<html>example</html>",
                uri: "ui://example/app.html",
            },
        ]);
    } finally {
        await server.close();
    }
});

test("Workspace MCP App renders from a versioned URI while keeping the stable reader alias", async () => {
    const binding = createBinding(createWorkerHarness(), {
        mcpApp: true,
    });
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        assert.deepEqual(
            session.initializeResult?.capabilities?.extensions?.[
                "io.modelcontextprotocol/ui"
            ],
            {},
        );
        const listed = await postJson(
            server.url,
            {
                id: "req-resources-list",
                jsonrpc: "2.0",
                method: "resources/list",
                params: {},
            },
            session.headers,
        );
        assert.equal(listed.status, 200);
        assert.deepEqual(
            listed.body.result?.resources?.map(
                (resource: { mimeType?: string; uri?: string }) => ({
                    mimeType: resource.mimeType,
                    uri: resource.uri,
                }),
            ),
            [
                {
                    mimeType: "text/html;profile=mcp-app",
                    uri: mcpAppResourceUri,
                },
            ],
        );
        assert.notEqual(mcpAppResourceUri, mcpAppStableResourceUri);

        const read = await postJson(
            server.url,
            {
                id: "req-resource-read",
                jsonrpc: "2.0",
                method: "resources/read",
                params: { uri: mcpAppStableResourceUri },
            },
            session.headers,
        );
        assert.equal(read.status, 200);
        assert.equal(
            read.body.result?.contents?.[0]?.mimeType,
            "text/html;profile=mcp-app",
        );
        assert.equal(
            read.body.result?.contents?.[0]?.uri,
            mcpAppStableResourceUri,
        );
        assert.deepEqual(
            read.body.result?.contents?.[0]?._meta,
            mcpAppResourceMeta,
        );
        assert.equal(mcpAppLegacyResourceUris.length, 5);
        for (const [index, uri] of mcpAppLegacyResourceUris.entries()) {
            const legacy = await postJson(
                server.url,
                {
                    id: `req-resource-read-legacy-${index}`,
                    jsonrpc: "2.0",
                    method: "resources/read",
                    params: { uri },
                },
                session.headers,
            );
            assert.equal(legacy.status, 200);
            assert.equal(legacy.body.result?.contents?.[0]?.uri, uri);
            assert.equal(
                legacy.body.result?.contents?.[0]?.text,
                read.body.result?.contents?.[0]?.text,
            );
            assert.deepEqual(
                legacy.body.result?.contents?.[0]?._meta,
                mcpAppResourceMeta,
            );
        }
    } finally {
        await server.close();
    }
});

test("Workspace MCP App uses the configured public origin as its ChatGPT component domain", async () => {
    const binding = createBinding(createWorkerHarness(), {
        publicBaseUrl: "https://devshell.example.com/prefix",
        mcpApp: true,
    });
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const read = await postJson(
            server.url,
            {
                id: "req-resource-domain",
                jsonrpc: "2.0",
                method: "resources/read",
                params: { uri: mcpAppResourceUri },
            },
            session.headers,
        );
        assert.equal(read.status, 200);
        assert.deepEqual(read.body.result?.contents?.[0]?._meta, {
            ...mcpAppResourceMeta,
            ui: {
                ...mcpAppResourceMeta.ui,
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
        const binding = createBinding(createWorkerHarness(), {
            publicBaseUrl,
            mcpApp: true,
        });
        const server = await createBindingServer(binding);
        try {
            const session = await initialize(server.url);
            const read = await postJson(
                server.url,
                {
                    id: `req-resource-wildcard-${publicBaseUrl}`,
                    jsonrpc: "2.0",
                    method: "resources/read",
                    params: { uri: mcpAppResourceUri },
                },
                session.headers,
            );
            assert.equal(read.status, 200);
            assert.deepEqual(
                read.body.result?.contents?.[0]?._meta,
                mcpAppResourceMeta,
            );
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
        const initializeResponse = await postJson(
            server.url,
            await readFixture("mcp-initialize.json"),
            staleHeaders,
        );
        assert.equal(initializeResponse.status, 200);
        assert.equal(initializeResponse.headers.get("mcp-session-id"), null);

        const listResponse = await postJson(
            server.url,
            {
                id: "req-stateless-tools-list",
                jsonrpc: "2.0",
                method: "tools/list",
                params: {},
            },
            staleHeaders,
        );
        assert.equal(listResponse.status, 200);
        assert.ok(Array.isArray(listResponse.body.result?.tools));

        assert.deepEqual(
            harness.events.map((event) => event.type),
            [],
        );
    } finally {
        await server.close();
    }
});

test("tools/list exposes the fixed worker catalog without group or capability filtering", async () => {
    const binding = createBinding();
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(
            server.url,
            await readFixture("mcp-tools-list.json"),
            session.headers,
        );

        assert.equal(response.status, 200);
        const listedTools = response.body.result?.tools ?? [];
        const names = listedTools.map((tool: { name: string }) => tool.name);
        assert.equal(names.includes("bash_run"), true);
        assert.equal(names.includes("file_logs"), true);
        const bashTool = listedTools.find(
            (tool: { name: string }) => tool.name === "bash_run",
        ) as
            | {
                  _meta?: { securitySchemes?: unknown };
                  securitySchemes?: unknown;
              }
            | undefined;
        assert.deepEqual(bashTool?.securitySchemes, [{ type: "noauth" }]);
        assert.deepEqual(bashTool?._meta?.securitySchemes, [
            { type: "noauth" },
        ]);
    } finally {
        await server.close();
    }
});

test("cached removed tool recipients return a structured tombstone over MCP", async () => {
    const binding = createBinding();
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const listed = await postJson(
            server.url,
            await readFixture("mcp-tools-list.json"),
            session.headers,
        );
        const names =
            listed.body.result?.tools.map(
                (tool: { name: string }) => tool.name,
            ) ?? [];
        assert.equal(names.includes("context_message_read"), false);

        const response = await postJson(
            server.url,
            {
                id: "req-stale-tool",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    arguments: {},
                    name: "context_message_read",
                },
            },
            session.headers,
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.error, undefined);
        assert.equal(response.body.result?.isError, false);
        assert.match(
            response.body.result?.content?.[0]?.text ?? "",
            /Cached tool context_message_read was removed/,
        );
        assert.equal(
            response.body.result?.structuredContent?.staleToolSnapshot?.name,
            "context_message_read",
        );
        assert.equal(
            response.body.result?.structuredContent?.staleToolSnapshot
                ?.replacement,
            undefined,
        );
    } finally {
        await server.close();
    }
});

test("tools/call delegates through the host ToolCall API", async () => {
    const harness = createWorkerHarness();
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(
            server.url,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            session.headers,
        );

        assert.equal(response.status, 200);
        assert.equal(harness.calls.length, 1);
        assert.deepEqual(harness.calls[0]?.input, { command: "pwd" });
        assert.equal(harness.calls[0]?.requestId, "req-tools-call");
        assert.equal(harness.calls[0]?.ctxId, ctxId);
        assert.equal(harness.calls[0]?.source, "mcp");
        assert.equal(harness.calls[0]?.toolName, "bash_run");
        assert.deepEqual(
            harness.events.map((event) => event.type),
            ["mcp.toolCalled", "mcp.toolCalled"],
        );
        assert.deepEqual(harness.events[1]?.data, {
            ctxId,
            requestId: "req-tools-call",
            source: "mcp",
            toolName: "bash_run",
        });
        assert.equal(response.body.result?.isError, false);
        assert.deepEqual(response.body.result?.content, []);
        assert.deepEqual(response.body.result?.structuredContent, {
            exitCode: 0,
            stderr: "",
            stdout: "/workspace\n",
        });
    } finally {
        await server.close();
    }
});

test("tools/call forwards stale worker arguments even when the advertised schema has changed", async () => {
    const harness = createWorkerHarness({
        tools: [
            {
                requiredCapabilities: ["read"],
                group: "file",
                name: "file_read",
                description: "Read files in a batch",
                inputSchema: {
                    additionalProperties: false,
                    properties: {
                        files: {
                            items: {
                                additionalProperties: false,
                                properties: { path: { type: "string" } },
                                required: ["path"],
                                type: "object",
                            },
                            minItems: 1,
                            type: "array",
                        },
                    },
                    required: ["files"],
                    type: "object",
                },
                outputSchema: { type: "object" },
            },
        ],
    });
    const binding = new McpEndpointBinding(
        createTestMcpEndpoint({
            instanceName: "demo",
            context: harness.context,
            tools: harness.tools,
            toolSource: harness.toolRegistry,
        }),
    );
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const legacyArguments = {
            ctxId,
            path: "./legacy.txt",
            selector: "1-1:raw",
            view: "content",
        };
        const response = await postJson(
            server.url,
            {
                id: "req-stale-file-read",
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    arguments: legacyArguments,
                    name: "file_read",
                },
            },
            session.headers,
        );

        assert.equal(response.status, 200);
        assert.equal(
            response.body.error,
            undefined,
            JSON.stringify(response.body),
        );
        assert.equal(harness.calls.length, 1);
        assert.deepEqual(harness.calls[0]?.input, {
            path: "./legacy.txt",
            selector: "1-1:raw",
            view: "content",
        });
    } finally {
        await server.close();
    }
});

test("tools/call returns a structured hint when the tool fails", async () => {
    const harness = createWorkerHarness({
        async callHandler() {
            throw new Error("command failed");
        },
        comments: ["[error.unknown] Inspect the error before retrying."],
    });
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(
            server.url,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            session.headers,
        );

        assert.equal(response.status, 200);
        const comments = response.body.error?.data?.comment as string[];
        assert.match(comments[0] ?? "", /^\[error\.unknown\] /);
    } finally {
        await server.close();
    }
});

test("tools/call preserves comments when the thrown Error is frozen", async () => {
    const frozen = Object.freeze(new Error("command failed"));
    const harness = createWorkerHarness({
        async callHandler() {
            throw frozen;
        },
        comments: ["[error.unknown] Inspect the error before retrying."],
    });
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(
            server.url,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            session.headers,
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.error?.message, "command failed");
        assert.deepEqual(response.body.error?.data?.comment, [
            "[error.unknown] Inspect the error before retrying.",
        ]);
        assert.equal("comment" in frozen, false);
    } finally {
        await server.close();
    }
});

test("tools/call appends a worker result hint and keeps the flat shape", async () => {
    const harness = createWorkerHarness({
        comments: ["[bash.nonZeroExit] Exited with code 7; inspect output."],
        result: {
            exitCode: 7,
            stderr: "boom",
            stdout: "",
            termination: "exited",
        },
    });
    const binding = createBinding(harness);
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(
            server.url,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            session.headers,
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

test("explicit context mode exposes ctxId and does not bind authority to OpenAI session metadata", async () => {
    const harness = createWorkerHarness();
    const provenanceRecords: Array<{
        callId: string;
        explanation?: string;
        instance: string;
        purpose?: string;
    }> = [];
    const endpoint = createTestMcpEndpoint({
        instanceName: "demo",
        toolProvenance: {
            async record(record) {
                provenanceRecords.push(record);
            },
        },
        context: harness.context,
        tools: harness.tools,
        toolSource: harness.toolRegistry,
    });
    const bashTool = endpoint
        .listTools()
        .find((tool) => tool.name === "bash_run");
    assert.notEqual(bashTool, undefined);
    const bashProperties = (
        bashTool?.inputSchema as {
            properties?: Record<
                string,
                { description?: string; maxLength?: number }
            >;
        }
    ).properties;
    assert.notEqual(bashProperties?.ctxId, undefined);
    assert.deepEqual(bashProperties?.purpose, {
        description: "Intended outcome.",
        maxLength: 160,
        minLength: 1,
        type: "string",
    });
    assert.deepEqual(bashProperties?.explanation, {
        description: "Why this call is useful.",
        maxLength: 1000,
        minLength: 1,
        type: "string",
    });
    const environmentTool = endpoint
        .listTools()
        .find((tool) => tool.name === "environ_info");
    const environmentInputProperties = (
        environmentTool?.inputSchema as {
            properties?: Record<string, unknown>;
        }
    ).properties;
    assert.equal(environmentInputProperties?.purpose, undefined);
    assert.equal(environmentInputProperties?.explanation, undefined);
    assert.notEqual(environmentInputProperties?.ctxId, undefined);
    assert.deepEqual(environmentTool?.outputSchema, { type: "object" });

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
        {
            command: "pwd",
            ctxId,
            explanation:
                "The prior result came from a different OpenAI session binding.",
            purpose: "Verify explicit Context authority",
        },
        {
            ...requestContext,
            requestMeta: { "openai/session": "chat-session-2" },
        },
    );
    assert.equal(harness.calls[0]?.ctxId, ctxId);
    assert.deepEqual(harness.calls[0]?.input, { command: "pwd" });
    assert.deepEqual(provenanceRecords, [
        {
            callId: "call-test",
            explanation:
                "The prior result came from a different OpenAI session binding.",
            instance: "demo",
            purpose: "Verify explicit Context authority",
        },
    ]);

    await assert.rejects(
        endpoint.callTool(
            "bash_run",
            { command: "pwd", ctxId, purpose: "x".repeat(161) },
            requestContext,
        ),
        (error: unknown) =>
            (error as { code?: string }).code === "control.invalidTarget",
    );

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
                    requestId: "req-unknown-tool",
                },
            },
            session.headers,
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
        },
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
                    name: "bash_run",
                },
            }),
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                ...session.headers,
            },
            method: "POST",
            signal: requestController.signal,
        }).catch(() => undefined);

        await started;
        requestController.abort("gateway timeout");
        await pendingCall;
        await waitFor(() => observedSignal?.aborted === true);
        assert.equal(observedSignal?.reason instanceof Error, true);
        assert.match(
            (observedSignal?.reason as Error).message,
            /connection closed/iu,
        );
    } finally {
        await server.close();
    }
});

test("tools/list returns cached schema while the instance is not ready", async () => {
    const binding = createBinding(createWorkerHarness({ ready: false }));
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const response = await postJson(
            server.url,
            await readFixture("mcp-tools-list.json"),
            session.headers,
        );

        assert.equal(response.status, 200);
        assert.equal(
            response.body.result?.tools.some(
                (tool: { name: string }) => tool.name === "bash_run",
            ),
            true,
        );
    } finally {
        await server.close();
    }
});

test("environ_info remains callable without a worker schema", async () => {
    const harness = createWorkerHarness({
        hasToolSchemaCache: false,
        ready: false,
        tools: [],
    });
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
    const binding = createBinding(createWorkerHarness({ ready: false }));
    const server = await createBindingServer(binding);

    try {
        const session = await initialize(server.url);
        const ctxId = await createContext(server.url, session.headers);
        const response = await postJson(
            server.url,
            withToolContext(await readFixture("mcp-tools-call.json"), ctxId),
            session.headers,
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.error?.data?.code, "mcp.instanceNotReady");
    } finally {
        await server.close();
    }
});

function createBinding(
    harness = createWorkerHarness(),
    options?: {
        contextMode?: "explicit" | "openai-session";
        publicBaseUrl?: string;
        serverVersion?: string;
        mcpApp?: boolean;
    },
): McpEndpointBinding {
    const extensions =
        options?.mcpApp === true
            ? new McpExtensionRegistry([
                  createMcpAppMcpExtension(options.publicBaseUrl),
              ])
            : undefined;
    return new McpEndpointBinding(
        createTestMcpEndpoint({
            contextMode: options?.contextMode,
            ...(extensions === undefined ? {} : { extensions }),
            context: harness.context,
            instanceName: "demo",
            tools: harness.tools,
            toolSource: harness.toolRegistry,
        }),
        options?.serverVersion,
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

async function initialize(url: string): Promise<{
    headers: Record<string, string>;
    initializeResult?: {
        capabilities?: { extensions?: Record<string, JsonValue> };
    };
}> {
    const response = await postJson(
        url,
        await readFixture("mcp-initialize.json"),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-session-id"), null);

    const headers: Record<string, string> = {
        "mcp-protocol-version": String(
            response.body.result?.protocolVersion ?? "",
        ),
    };
    const initialized = await postRawJson(
        url,
        {
            jsonrpc: "2.0",
            method: "notifications/initialized",
        },
        headers,
    );

    assert.equal(initialized.status, 202);
    return {
        headers,
        initializeResult: response.body.result as
            | {
                  capabilities?: { extensions?: Record<string, JsonValue> };
              }
            | undefined,
    };
}

async function createContext(
    url: string,
    headers: Record<string, string>,
    workspace = "/workspace",
): Promise<string> {
    const response = await postJson(
        url,
        {
            id: `req-environ-${Date.now()}`,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: { workspace }, name: "environ_info" },
        },
        headers,
    );
    assert.equal(
        response.body.error,
        undefined,
        `environ_info returned a JSON-RPC error: ${JSON.stringify(response.body.error)}`,
    );
    const ctxId = response.body.result?.structuredContent?.ctxId;
    assert.equal(typeof ctxId, "string", JSON.stringify(response.body.result));
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

async function postJson(
    url: string,
    body: JsonValue,
    extraHeaders?: Record<string, string>,
) {
    const response = await postRawJson(url, body, extraHeaders);

    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: parseMcpHttpResponse<Record<string, any>>(response.text),
        headers: response.headers,
        status: response.status,
    };
}

async function postRawJson(
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

    return {
        headers: response.headers,
        text: await response.text(),
        status: response.status,
    };
}

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(
        await readFile(resolve(fixturesDirectory, name), "utf8"),
    ) as JsonValue;
}

function createWorkerHarness(options?: {
    callHandler?: (
        toolName: string,
        input: JsonValue,
        context: { ctxId?: string; requestId?: string; source: string },
        signal?: AbortSignal,
    ) => Promise<CommandResult>;
    comments?: readonly string[];
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
    const definitions: ToolDefinition[] = options?.tools ?? [
        {
            requiredCapabilities: ["execute"] as const,
            group: "bash",
            name: "bash_run",
            description: "Run shell",
            inputSchema: {
                type: "object",
                properties: { command: { type: "string" } },
            },
            outputSchema: { type: "object" },
        },
        {
            requiredCapabilities: ["read"] as const,
            group: "file",
            name: "file_logs",
            description: "Read logs",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
        },
    ];
    const toolRegistry = new TestToolSource();
    toolRegistry.register("*", contextToolDefinitions());
    toolRegistry.register("demo", definitions);
    const hasToolSchemaCache = options?.hasToolSchemaCache ?? true;
    const ready = options?.ready ?? true;
    const result = options?.result ?? {
        exitCode: 0,
        stderr: "",
        stdout: "/workspace\n",
    };

    const worker = {
        async appendMcpSessionClosed(sessionId: string) {
            events.push({ data: { sessionId }, type: "mcp.sessionClosed" });
        },
        async appendMcpSessionOpened(sessionId: string) {
            events.push({ data: { sessionId }, type: "mcp.sessionOpened" });
        },
        async appendMcpToolCalled(
            toolName: string,
            context: { ctxId?: string; requestId?: string },
        ) {
            events.push({
                data: {
                    requestId: context.requestId ?? null,
                    ctxId: context.ctxId ?? null,
                    source: "mcp",
                    toolName,
                },
                type: "mcp.toolCalled",
            });
        },
        handshake: {
            homeDirectory: "/home/demo",
            instance: "demo",
            platform: {
                arch: "x86_64",
                distribution: {
                    id: "arch",
                    name: "Arch Linux",
                    version: "rolling",
                },
                os: "linux",
                packageManager: "pacman",
                shell: {
                    executable: "/bin/bash",
                    kind: "bash",
                    version: "5",
                },
            },
        },
        async prepareExtensionResource(input: {
            collection: string;
            extensionId: string;
        }) {
            assert.deepEqual(input, {
                collection: "managed",
                extensionId: "skill",
            });
            return {
                directory:
                    "/home/demo/.devshell/demo/extensions/skill/resources/managed",
            };
        },
        async prepareWorkspace(workspace: string) {
            return {
                projectMemoryAgentFile: `${workspace}/.devshell/AGENT.md`,
                projectMemoryDirectory: `${workspace}/.devshell`,
                projectMemoryPresent: true,
                temporaryDirectory: "/tmp/workspace-123456",
                workspace,
            };
        },
        async readAlerts() {
            return { advice: [] };
        },
        hasToolSchemaCache() {
            return hasToolSchemaCache;
        },
        snapshot() {
            return { ready };
        },
        listTools() {
            return definitions;
        },
    };
    const contexts = new Map<string, ContextRecord>();
    const context = {
        async resolve(input: { ctxId?: string; principal: string }) {
            const record = input.ctxId === undefined ? undefined : contexts.get(input.ctxId);
            if (record === undefined || record.principal !== input.principal)
                throw Object.assign(new Error("Context is invalid."), { code: "mcp.contextInvalid" });
            return record;
        },
    } as Pick<ContextTransport, "resolve">;
    const tools: ToolCallApi = {
        async call(
            instance: string,
            toolName: string,
            input: JsonValue,
            callContext: { ctxId?: string; principal?: string; requestId?: string; source?: string },
            signal?: AbortSignal,
            transformResult?: (result: JsonValue, callId: string) => Promise<JsonValue>,
            invocationInput?: (input: JsonValue, callId: string, finalValue: ToolCallHookValue) => Promise<JsonValue> | JsonValue,
        ): Promise<JsonValue> {
            signal?.throwIfAborted();
            if (toolName === "environ_info") {
                const ctxId = typeof (input as { ctxId?: unknown }).ctxId === "string"
                    ? (input as { ctxId: string }).ctxId
                    : "ctx-endpoint-test";
                const workspace = typeof (input as { workspace?: unknown }).workspace === "string"
                    ? (input as { workspace: string }).workspace
                    : "/workspace";
                const now = new Date(0).toISOString();
                contexts.set(ctxId, {
                    createdAt: now,
                    ctxId,
                    environments: [{ instance, workspace }],
                    expiresAt: new Date(86_400_000).toISOString(),
                    lastAccessedAt: now,
                    principal: callContext.principal ?? "test",
                    status: "active",
                });
                return { ctxId, status: "active", workspace };
            }
            const contextValue = {
                ctxId: callContext.ctxId,
                instance: asInstanceName(instance),
                source: callContext.source ?? "mcp",
                requestId: callContext.requestId,
            };
            const callId = "call-test";
            auditedCalls.push({
                context: { ...callContext, source: callContext.source ?? "mcp" },
                input,
                toolName,
            });
            const finalValue: ToolCallHookValue = {
                kind: "call",
                toolName,
                payload: input,
                context: contextValue as ToolCallHookValue["context"],
            };
            const effectiveInput = await invocationInput?.(input, callId, finalValue) ?? input;
            if (!worker.snapshot().ready) {
                throw Object.assign(new Error("not ready"), { code: "core.instanceNotReady" });
            }
            const executionContext = {
                ctxId: callContext.ctxId,
                requestId: callContext.requestId,
                source: callContext.source ?? "mcp",
            };
            calls.push({ input: effectiveInput, toolName, ...executionContext });
            worker.appendMcpToolCalled(toolName, executionContext);
            let toolResult: JsonValue;
            try {
                toolResult = options?.callHandler === undefined
                    ? result
                    : await options.callHandler(toolName, effectiveInput, executionContext, signal);
            } catch (error) {
                if ((options?.comments?.length ?? 0) > 0 && error instanceof Error)
                    throw attachToolCallErrorPayload(error, { comment: [...options!.comments!] });
                throw error;
            }
            if ((options?.comments?.length ?? 0) > 0 && typeof toolResult === "object" && toolResult !== null && !Array.isArray(toolResult))
                toolResult = { ...toolResult, comment: [...options!.comments!] };
            return transformResult === undefined ? toolResult : await transformResult(toolResult, callId);
        },
    };
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
        context,
        tools,
        toolRegistry,
        worker,
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
