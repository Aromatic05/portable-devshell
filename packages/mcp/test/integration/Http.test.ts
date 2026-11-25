import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
    ToolCallApi,
    ToolCallHookValue,
    ToolDefinition,
} from "@portable-devshell/shared";
import { asInstanceName } from "@portable-devshell/shared";

import {
    requireTcpPort,
    startLoopbackHttpProxy,
} from "../../../../test/TestHttpSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { parseMcpHttpResponse } from "../TestMcpHttpResponse.ts";

import { TestMcpHost as McpHost, type TestMcpHostInstanceConfig } from "../ContextRuntime.ts";
import { mcpAppResourceUri, mcpAppInteractionResourceUri, mcpAppToolCallResourceUri } from "@portable-devshell/mcp/testing";
import type { McpAuthConfig } from "@portable-devshell/mcp";
import { McpOAuthApprovalService } from "../../src/oauth/interaction/Approval.ts";
import { McpOAuthProviderRuntime } from "../../src/oauth/provider/Provider.ts";

import {
    discoverModern,
    postModern,
    modernRequestInit,
    modernRpcRequest,
} from "./ModernProtocol.ts";

const fixturesDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../fixtures",
);
type JsonValue =
    | boolean
    | number
    | null
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

test("missing instance returns 404", async () => {
    const host = createHost();
    await host.start();

    try {
        const port = requireTcpPort(host.server.address);

        const response = await fetch(`http://127.0.0.1:${port}/missing/mcp`, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json")),
        });

        assert.equal(response.status, 404);
    } finally {
        await host.stop();
    }
});

test("published handshake revisions initialize, list and call tools alongside modern discovery", async () => {
    const host = createHost();
    await host.start();

    try {
        const port = requireTcpPort(host.server.address);
        const endpoint = `http://127.0.0.1:${port}/demo/mcp/explicit`;

        for (const protocolVersion of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
            const legacy = await fetch(endpoint, {
                method: "POST",
                headers: {
                    accept: "application/json, text/event-stream",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion,
                        capabilities: {},
                        clientInfo: { name: "compatibility-client", version: "1" },
                    },
                }),
            });
            assert.equal(legacy.status, 200, `initialize ${protocolVersion}`);
            const init = parseMcpHttpResponse<{
                result?: { protocolVersion?: string };
            }>(await legacy.text());
            assert.equal(init.result?.protocolVersion, protocolVersion);
            assert.equal(legacy.headers.get("mcp-session-id"), null);

            const legacyTools = await fetch(endpoint, {
                method: "POST",
                headers: {
                    accept: "application/json, text/event-stream",
                    "content-type": "application/json",
                    "mcp-protocol-version": protocolVersion,
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
            });
            assert.equal(legacyTools.status, 200, `tools/list ${protocolVersion}`);
            const listing = parseMcpHttpResponse<{ result?: { tools?: Array<{ name: string }> } }>(
                await legacyTools.text(),
            );
            assert.equal(listing.result?.tools?.some((tool) => tool.name === "bash_run"), true);

            const legacyCall = await fetch(endpoint, {
                method: "POST",
                headers: {
                    accept: "application/json, text/event-stream",
                    "content-type": "application/json",
                    "mcp-protocol-version": protocolVersion,
                },
                body: JSON.stringify({
                    jsonrpc: "2.0", id: 3, method: "tools/call",
                    params: { name: "environ_info", arguments: { workspace: "/workspace" } },
                }),
            });
            assert.equal(legacyCall.status, 200, `tools/call ${protocolVersion}`);
            const called = parseMcpHttpResponse<{ error?: unknown; result?: unknown }>(
                await legacyCall.text(),
            );
            assert.equal(called.error, undefined, `tools/call ${protocolVersion}`);
            assert.notEqual(called.result, undefined, `tools/call ${protocolVersion}`);
        }

        const discovery = await discoverModern(endpoint);
        assert.equal(discovery.status, 200);
        assert.match(discovery.headers.get("content-type") ?? "", /^application\/json\b/iu);
        const payload = parseMcpHttpResponse<{
            result?: { supportedVersions?: string[] };
        }>(await discovery.text());
        assert.equal(
            payload.result?.supportedVersions?.includes("2026-07-28"),
            true,
        );
        assert.equal(discovery.headers.get("mcp-session-id"), null);
    } finally {
        await host.stop();
    }
});

test("MCP request diagnostics record pre-auth rejection and successful 2025 discovery without secrets", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const host = createHost({
        auth: { enabled: true, provider: "token", token: "private-test-token" },
        requestLogger: (line) => entries.push(JSON.parse(line) as Record<string, unknown>),
    });
    await host.start();
    try {
        const endpoint = `http://127.0.0.1:${requireTcpPort(host.server.address)}/demo/mcp`;
        const headers = {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-11-25",
        };
        const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
        const denied = await fetch(`${endpoint}?secret=query-must-not-be-logged`, {
            method: "POST",
            headers: { ...headers, authorization: "Bearer invalid-test-token" },
            body: request,
        });
        assert.equal(denied.status, 401);
        await denied.text();

        const allowed = await fetch(endpoint, {
            method: "POST",
            headers: { ...headers, authorization: "Bearer private-test-token" },
            body: request,
        });
        assert.equal(allowed.status, 200);
        await allowed.text();

        const received = entries.filter((entry) => entry.event === "received");
        const finished = entries.filter((entry) => entry.event === "finished");
        assert.equal(received.length, 2);
        assert.equal(finished.length, 2);
        assert.equal(finished[0]?.requestId, received[0]?.requestId);
        assert.equal(finished[0]?.status, 401);
        assert.equal(finished[0]?.auth, "rejected");
        assert.equal(finished[1]?.requestId, received[1]?.requestId);
        assert.equal(finished[1]?.status, 200);
        assert.equal(finished[1]?.auth, "accepted");
        assert.equal(finished[1]?.rpcMethod, "tools/list");
        assert.equal(finished[1]?.protocolVersion, "2025-11-25");
        assert.equal(JSON.stringify(entries).includes("private-test-token"), false);
        assert.equal(JSON.stringify(entries).includes("invalid-test-token"), false);
        assert.equal(JSON.stringify(entries).includes("query-must-not-be-logged"), false);
    } finally {
        await host.stop();
    }
});

test("legacy clients explicitly select Context by URL without activating OpenAI mode", async () => {
    const workspace = await createTestTempDirectory("mcp-explicit");
    const host = createHost({ contextTools: true });
    await host.start();
    try {
        const endpoint = `http://127.0.0.1:${requireTcpPort(host.server.address)}/demo/mcp/explicit`;
        const legacyRpc = async (id: number, method: string, params: Record<string, unknown>, url = endpoint) => {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    accept: "application/json, text/event-stream",
                    "content-type": "application/json",
                    "mcp-protocol-version": "2025-11-25",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            });
            assert.equal(response.status, 200, method);
            return parseMcpHttpResponse<{ error?: unknown; result?: {
                capabilities?: Record<string, unknown>;
                content?: Array<{ type?: string; text?: string }>;
                structuredContent?: { ctxId?: string };
                tools?: Array<{ name: string; inputSchema?: {
                    required?: string[]; properties?: Record<string, unknown>;
                }; outputSchema?: { properties?: Record<string, unknown> }; _meta?: Record<string, unknown> }>;
            } }>(await response.text());
        };
        const init = await legacyRpc(1, "initialize", {
            protocolVersion: "2025-11-25", capabilities: {},
            clientInfo: { name: "standard-mcp", version: "1" },
        });
        assert.equal(init.result?.capabilities?.extensions, undefined);
        const listed = await legacyRpc(2, "tools/list", {});
        const bash = listed.result?.tools?.find((tool) => tool.name === "bash_run");
        assert.ok(bash?.inputSchema?.required?.includes("ctxId"));
        for (const name of ["environ_info", "environ_remote"]) {
            const bootstrap = listed.result?.tools?.find((tool) => tool.name === name);
            assert.equal(bootstrap?.inputSchema?.properties?.ctxId, undefined);
            assert.notEqual(bootstrap?.inputSchema?.required?.includes("ctxId"), true);
        }
        assert.notEqual(
            listed.result?.tools?.find((tool) => tool.name === "environ_info")
                ?.outputSchema?.properties?.ctxId, undefined,
        );
        assert.equal(bash?._meta?.["openai/outputTemplate"], undefined);
        assert.equal(listed.result?.tools?.some((tool) => tool.name === "mcpapp_open"), false);
        const remoteHelp = await legacyRpc(30, "tools/call", {
            name: "environ_remote", arguments: { command: "help" },
        });
        assert.equal(remoteHelp.error, undefined);
        const info = await legacyRpc(3, "tools/call", {
            name: "environ_info", arguments: { workspace },
        });
        const ctxId = (JSON.parse(info.result?.content?.[0]?.text ?? "{}") as { ctxId?: string }).ctxId;
        assert.ok(typeof ctxId === "string", JSON.stringify(info));
        assert.match(ctxId, /^ctx-/u);
        assert.equal(info.result?.structuredContent?.ctxId, ctxId);
        const resumed = await legacyRpc(4, "tools/call", {
            name: "environ_info", arguments: { ctxId },
        });
        assert.equal(resumed.result?.structuredContent?.ctxId, ctxId);
        const executed = await legacyRpc(5, "tools/call", {
            name: "bash_run", arguments: { ctxId, command: "pwd" },
        });
        assert.equal(executed.error, undefined);
        assert.equal(JSON.parse(executed.result?.content?.[0]?.text ?? "{}").stdout, "ok\n");
        const remote = await host.contexts.registry.referenceInstance(ctxId, "remote-test");
        assert.ok(remote);
        const masked = await legacyRpc(31, "tools/call", {
            name: "environ_remote", arguments: { command: "mask", handle: remote.handle },
        });
        assert.equal(masked.error, undefined, JSON.stringify(masked));
        assert.equal(masked.result?.structuredContent?.ctxId, ctxId);

        const foreignMetadata = await legacyRpc(6, "tools/list", {
            _meta: { "openai/session": "must-not-select-other-mode" },
        });
        assert.deepEqual(foreignMetadata.result?.tools, listed.result?.tools);
        const openAiList = await legacyRpc(7, "tools/list", {}, new URL("./openai-session", endpoint).href);
        assert.equal(openAiList.error, undefined);
        const openAiBash = openAiList.result?.tools?.find((tool) => tool.name === "bash_run");
        assert.ok(openAiBash);
        assert.equal(openAiBash.inputSchema?.properties?.ctxId, undefined);
        assert.equal(openAiBash.inputSchema?.required?.includes("ctxId") ?? false, false);
    } finally {
        await host.stop();
        await rm(workspace, { force: true, recursive: true });
    }
});

test("automatic route schemas stay fixed without session metadata and only bind the owning client ID", async (t) => {
    const workspace = await createTestTempDirectory("mcp-session-routes");
    const host = createHost({ contextTools: true });
    t.after(async () => { await host.stop(); await rm(workspace, { recursive: true, force: true }); });
    await host.start();
    const url = `http://127.0.0.1:${requireTcpPort(host.server.address)}/demo/mcp`;
    type Schema = { properties?: Record<string, unknown>; required?: string[] };
    type Tool = { name: string; inputSchema: Schema; outputSchema?: Schema; _meta?: Record<string, unknown> };
    type Payload = { error?: { message?: string }; result?: {
        tools?: Tool[]; structuredContent?: { ctxId?: string; stdout?: string }; content?: Array<{ text?: string }>;
    } };
    const rpc = async (suffix: string, method: string, params: Record<string, unknown> = {}) => {
        const response = await postModern(`${url}${suffix}`, method, method, params);
        assert.equal(response.status, 200, method);
        return parseMcpHttpResponse<Payload>(await response.text());
    };
    const openai = "openai/session";
    const agy = "antigravity.google/conversation_id";
    const list = async (suffix: string, metadata?: Record<string, string>) => {
        const listed = await rpc(suffix, "tools/list", metadata === undefined ? {} : { _meta: metadata });
        assert.equal(listed.error, undefined);
        assert.ok(listed.result?.tools);
        return listed.result.tools;
    };
    assert.deepEqual(await list(""), await list("/openai-session", { [openai]: "chat" }));
    for (const [suffix, key, wrongKey] of [["", openai, agy], ["/agy-session", agy, openai]] as const) {
        const first = await list(suffix);
        assert.deepEqual(await list(suffix, { [key]: "chat" }), first);
        for (const name of ["bash_run", "environ_info", "environ_remote"]) {
            const tool = first.find((entry) => entry.name === name);
            assert.ok(tool, name);
            assert.equal(tool.inputSchema.properties?.ctxId, undefined, name);
            assert.equal(tool.inputSchema.required?.includes("ctxId") ?? false, false, name);
            assert.equal(tool.outputSchema?.properties?.ctxId, undefined, name);
        }
        const before = await host.contexts.registry.list();
        const missing = await rpc(suffix, "tools/call", {
            name: "environ_info", arguments: { workspace }, _meta: { [wrongKey]: "chat" },
        });
        assert.ok(missing.error?.message?.includes(key));
        assert.deepEqual(await host.contexts.registry.list(), before);
        const bound = await rpc(suffix, "tools/call", {
            name: "environ_info", arguments: { workspace, ctxId: "must-not-select-context" },
            _meta: { [key]: "chat" },
        });
        assert.equal(bound.error, undefined);
        assert.ok(bound.result?.structuredContent);
        assert.equal(bound.result.structuredContent.ctxId, undefined);
        const call = await rpc(suffix === "" ? "/openai-session" : suffix, "tools/call", {
            name: "bash_run", arguments: { command: "pwd", ctxId: "must-not-select-context" },
            _meta: { [key]: "chat" },
        });
        assert.equal(call.error, undefined);
        assert.equal(call.result?.structuredContent?.stdout, "ok\n");
        assert.equal(call.result?.structuredContent?.ctxId, undefined);
    }
    const agyParams = { arguments: { command: "pwd" }, _meta: { [agy]: "chat" } };
    const text = await rpc("/agy-session", "tools/call", { name: "bash_run", ...agyParams });
    assert.equal(JSON.parse(text.result?.content?.[0]?.text ?? "{}").stdout, "ok\n");
    assert.equal((await list("/agy-session")).some((tool) => tool.name.startsWith("mcpapp_")), false);
    const app = await rpc("/agy-session", "tools/call", { name: "mcpapp_open", arguments: {}, _meta: agyParams._meta });
    assert.match(app.error?.message ?? "", /not exposed/u);
    const bindings = await Promise.all([openai, agy].map((kind) =>
        host.contexts.registry.lookupExternal({ kind, value: "chat" }, { principal: "local" })));
    assert.ok(bindings[0]);
    assert.ok(bindings[1]);
    assert.notEqual(bindings[0].ctxId, bindings[1].ctxId);
    assert.equal((await host.contexts.registry.list()).length, 2);
});

test("quiet ToolCall keeps the HTTP connection live before the Worker finishes", async () => {
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const base = createHttpToolCallApi();
    const tools: ToolCallApi = {
        async call(...args) {
            if (args[1] === "bash_run") {
                entered();
                await gate;
            }
            return await base.call(...args);
        },
    };
    const host = createHost({ tools });
    await host.start();
    try {
        const endpoint = `http://127.0.0.1:${requireTcpPort(host.server.address)}/demo/mcp/explicit`;
        const context = await host.contexts.registry.create({ principal: "local" });
        const ctxId = context.ctxId;
        await host.contexts.registry.referenceInstance(ctxId, "demo");
        const pending = postModern(endpoint, "slow-call", "tools/call", {
            name: "bash_run",
            arguments: { command: "quiet long-running operation", ctxId },
        });
        await Promise.race([started, new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("slow call never entered ToolCall API")), 3_000),
        )]);
        const response = await Promise.race([
            pending,
            new Promise<never>((_, reject) => setTimeout(
                () => reject(new Error("quiet SSE call never sent a heartbeat")),
                3_000,
            )),
        ]);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream\b/iu);
        resume();
        const result = parseMcpHttpResponse<{ result?: {
            structuredContent?: { stdout?: string };
        } }>(await response.text());
        assert.equal(result.result?.structuredContent?.stdout, "ok\n");
        const short = await postModern(endpoint, "short-call", "tools/call", {
            name: "environ_info",
            arguments: { workspace: "/workspace" },
        });
        assert.equal(short.status, 200);
        assert.match(short.headers.get("content-type") ?? "", /^application\/json\b/iu);
    } finally {
        resume();
        await host.stop();
    }
});

test("production MCP host advertises and reads its MCP App resource", async () => {
    const host = createHost();
    await host.start();
    try {
        const port = requireTcpPort(host.server.address);
        const endpoint = `http://127.0.0.1:${port}/demo/mcp`;
        const request = async (method: string, params: JsonValue = {}) => {
            const response = await postModern(
                endpoint,
                method,
                method,
                params as Record<string, unknown>,
            );
            assert.equal(response.status, 200);
            assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/iu);
            return parseMcpHttpResponse<{
                result?: {
                    resources?: Array<{ uri: string; mimeType: string }>;
                    contents?: Array<{ uri: string; mimeType: string; text: string;
                        _meta?: { "openai/ui"?: { availableDisplayModes: string[] } } }>;
                    tools?: Array<{ name: string; _meta?: { ui?: { resourceUri?: string } } }>;
                };
            }>(await response.text());
        };
        const listed = await request("resources/list");
        assert.ok(listed.result?.resources?.some((entry) => entry.uri === mcpAppResourceUri && entry.mimeType === "text/html;profile=mcp-app"));
        assert.ok(listed.result?.resources?.some((entry) => entry.uri === mcpAppInteractionResourceUri && entry.mimeType === "text/html;profile=mcp-app"));
        assert.ok(listed.result?.resources?.some((entry) => entry.uri === mcpAppToolCallResourceUri && entry.mimeType === "text/html;profile=mcp-app"));
        const read = await request("resources/read", { uri: mcpAppResourceUri });
        assert.equal(read.result?.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
        assert.deepEqual(read.result?.contents?.[0]?._meta?.["openai/ui"]?.availableDisplayModes, ["fullscreen"]);
        const readInline = await request("resources/read", { uri: mcpAppInteractionResourceUri });
        assert.equal(readInline.result?.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
        assert.deepEqual(readInline.result?.contents?.[0]?._meta?.["openai/ui"]?.availableDisplayModes, ["inline"]);
        assert.match(readInline.result?.contents?.[0]?.text ?? "", /data-mcpapp-view="interaction"/u);
        const readToolCall = await request("resources/read", { uri: mcpAppToolCallResourceUri });
        assert.equal(readToolCall.result?.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
        assert.deepEqual(readToolCall.result?.contents?.[0]?._meta?.["openai/ui"]?.availableDisplayModes, ["inline"]);
        assert.match(readToolCall.result?.contents?.[0]?.text ?? "", /data-mcpapp-view="toolcall"/u);
        const html = read.result?.contents?.[0]?.text ?? "";
        assert.match(html, /<html\b/u);
        assert.equal(html.includes("<script>"), false);
        const assets = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/gu), (match) => match[1]!)
            .filter((path) => path.startsWith("/mcpapp/assets/"));
        assert.ok(assets.some((path) => path.endsWith(".js")));
        assert.ok(assets.some((path) => path.endsWith(".css")));
        for (const path of assets) {
            const asset = await fetch(`http://127.0.0.1:${port}${path}`);
            assert.equal(asset.status, 200);
            assert.ok((await asset.text()).length > 100);
        }
        const tools = await request("tools/list");
        const bootstrap = tools.result?.tools?.find((tool) => tool.name === "environ_info");
        // Default ToolCall presentation is read from the Workspace timeline;
        // the Inline asset remains a resource but is not bound by default.
        assert.equal(bootstrap?._meta?.ui?.resourceUri, undefined);
        // This minimal HTTP host only registers environ_info. The full MCP
        // catalog's model-facing open binding is verified separately.
        assert.equal(tools.result?.tools?.some((tool) => tool.name === "mcpapp_open"), false);
    } finally {
        await host.stop();
    }
});

test("a namespace with no auth remains runnable behind a public MCP URL", async () => {
    const host = createHost({ publicBaseUrl: "https://dev.aromatic05.top" });
    await host.start();

    try {
        const port = requireTcpPort(host.server.address);
        const response = await discoverModern(
            `http://127.0.0.1:${port}/demo/mcp`,
        );

        assert.equal(response.status, 200);
    } finally {
        await host.stop();
    }
});

test("a running host can add an OAuth namespace without exposing it as local auth", async () => {
    const storageDir = await createTestTempDirectory("mcp-dynamic-oauth");
    const host = createHost({
        publicBaseUrl: "http://127.0.0.1",
        storageDir,
    });
    await host.start();

    try {
        host.registerInstance(
            createInstance("dynamic", {
                enabled: true,
                oauth2: {
                    requiredScopes: ["mcp-dynamic"],
                    resourceName: "dynamic",
                },
                provider: "oauth2",
            }),
        );
        const port = requireTcpPort(host.server.address);
        const endpoint = `http://127.0.0.1:${port}/dynamic/mcp`;
        const unauthorized = await fetch(endpoint, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json")),
        });
        assert.equal(unauthorized.status, 401);

        const metadata = await fetch(
            `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/dynamic/mcp`,
        );
        assert.equal(metadata.status, 200);
        assert.deepEqual(await metadata.json(), {
            authorization_servers: ["http://127.0.0.1"],
            resource: "http://127.0.0.1/dynamic/mcp",
            resource_name: "dynamic",
            scopes_supported: ["mcp-dynamic"],
        });
        assert.equal(host.status().authMode, "oauth2");
        assert.equal(host.status().oauthReady, true);
    } finally {
        await host.stop();
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("MCP status reports observable listener state without claiming unimplemented protocol or public reachability probes", async () => {
    const host = createHost({ publicBaseUrl: "https://mcp.example.test" });
    const stopped = host.status();
    assert.equal(stopped.running, false);
    assert.equal(stopped.reason, "MCP host is not listening.");
    assert.equal("protocolReadiness" in stopped, false);
    assert.equal("publicReachability" in stopped, false);

    await host.start();
    try {
        const running = host.status();
        assert.equal(running.running, true);
        assert.equal(typeof running.listenAddress, "string");
        assert.equal("reason" in running, false);
        assert.equal("protocolReadiness" in running, false);
        assert.equal("publicReachability" in running, false);
    } finally {
        await host.stop();
    }
});

test("oauth2 emits HTTPS endpoints behind a loopback reverse proxy", async () => {
    const storageDir = await createTestTempDirectory("mcp-proxy");
    const host = createHost({
        auth: {
            enabled: true,
            oauth2: {
                documentationUrl: "https://docs.example.com/aromatic",
                requiredScopes: ["mcp"],
                resourceName: "aromatic",
            },
            provider: "oauth2",
        },
        publicBaseUrl: "https://mcp.example.com",
        storageDir,
    });

    await host.start();

    try {
        const port = requireTcpPort(host.server.address);

        const response = await fetch(
            `http://127.0.0.1:${port}/.well-known/openid-configuration`,
            {
                headers: {
                    host: "mcp.example.com",
                    "x-forwarded-host": "mcp.example.com",
                    "x-forwarded-proto": "https",
                },
            },
        );
        assert.equal(response.status, 200);
        const metadata = (await response.json()) as {
            authorization_endpoint: string;
            issuer: string;
            token_endpoint: string;
        };

        assert.equal(metadata.issuer, "https://mcp.example.com");
        assert.equal(
            metadata.authorization_endpoint,
            "https://mcp.example.com/authorize",
        );
        assert.equal(metadata.token_endpoint, "https://mcp.example.com/token");
    } finally {
        await host.stop();
        await rm(storageDir, { force: true, recursive: true });
    }
});

test("OAuth carries the public prefix and does not reuse existing bare-route tokens on mode routes", async () => {
    const proxy = await startLoopbackHttpProxy();
    const origin = proxy.origin;
    const storageDir = await createTestTempDirectory("mcp-prefix");
    const config = { requiredScopes: ["mcp"], resourceName: "aromatic" };
    const basePath = "/devshell/demo/mcp";
    const publicBaseUrl = `${origin}/devshell`;
    const legacyIssuer = new McpOAuthProviderRuntime({
        approvals: new McpOAuthApprovalService(storageDir), config, publicBaseUrl, storageDir,
    });
    const release = legacyIssuer.registerResource(new URL(`${origin}${basePath}`), config);
    await legacyIssuer.warmup();
    const now = Math.floor(Date.now() / 1000);
    await legacyIssuer.provider.AccessToken.adapter.upsert("existing-bare-token", {
        aud: `${origin}${basePath}`, clientId: "existing-client", exp: now + 3600,
        grantId: "existing-grant", iat: now, kind: "AccessToken", scope: "mcp",
    }, 3600);
    release();
    const host = createHost({
        auth: {
            enabled: true,
            oauth2: config,
            provider: "oauth2",
        },
        listenPort: 0,
        publicBaseUrl,
        storageDir,
    });
    await host.start();
    proxy.setTarget(`http://127.0.0.1:${requireTcpPort(host.server.address)}`);

    try {
        for (const suffix of ["", "/openai-session", "/explicit", "/agy-session"]) {
            const resourcePath = `${basePath}${suffix}`;
            const protectedMetadata = await fetch(`${origin}/.well-known/oauth-protected-resource${resourcePath}`);
            assert.equal(protectedMetadata.status, 200, resourcePath);
            const resource = await protectedMetadata.json() as { authorization_servers: string[]; resource: string };
            assert.deepEqual(resource.authorization_servers, [origin]);
            assert.equal(resource.resource, `${origin}${resourcePath}`);

            const init = modernRequestInit("tools/list", modernRpcRequest("oauth-audience", "tools/list"));
            const headers = new Headers(init.headers);
            headers.set("authorization", "Bearer existing-bare-token");
            const response = await fetch(`${origin}${resourcePath}`, { ...init, headers });
            assert.equal(response.status, suffix === "" ? 200 : 401, resourcePath);
            await response.text();
        }

        const authorizationMetadata = await fetch(
            `${origin}/.well-known/openid-configuration`,
        );
        assert.equal(authorizationMetadata.status, 200);
        const issuer = (await authorizationMetadata.json()) as {
            authorization_endpoint: string;
            issuer: string;
        };
        assert.equal(issuer.issuer, origin);
        assert.equal(issuer.authorization_endpoint, `${origin}/authorize`);
    } finally {
        try {
            await host.stop();
            await rm(storageDir, { force: true, recursive: true });
        } finally {
            await proxy.close();
        }
    }
});

test("running host replaces and unregisters instance bindings without restart", async () => {
    const host = createHost();
    await host.start();

    try {
        const port = requireTcpPort(host.server.address);
        const endpoint = `http://127.0.0.1:${port}/demo/mcp`;

        assert.deepEqual(await initializeAndListTools(endpoint), [
            "environ_info",
            "environ_remote",
            "bash_run",
        ]);

        const fileTool = {
            requiredCapabilities: ["read"],
            group: "file",
            name: "file_read",
            description: "Read a file",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
        } as const satisfies ToolDefinition;
        host.replaceTestTools("demo", [fileTool]);
        host.registerInstance({
            name: "demo",
        });
        assert.deepEqual(await initializeAndListTools(endpoint), [
            "environ_info",
            "environ_remote",
            "file_read",
        ]);
        const removedToolCall = await postModern(endpoint, "removed-tool", "tools/call", {
            arguments: { command: "pwd" },
            name: "bash_run",
        });
        assert.equal(removedToolCall.status, 200);
        const removedToolPayload = parseMcpHttpResponse<{
            error?: { data?: { code?: string }; message?: string };
            result?: unknown;
        }>(await removedToolCall.text());
        assert.equal(removedToolPayload.error?.data?.code, "core.toolSchemaUnavailable");
        assert.equal(removedToolPayload.result, undefined);

        host.unregisterInstance("demo");
        host.replaceTestTools("demo", []);
        for (const suffix of ["", "/openai-session", "/explicit", "/agy-session"]) {
            const missing = await postModern(`${endpoint}${suffix}`, "list-tools", "tools/list");
            assert.equal(missing.status, 404);
            await missing.text();
        }
    } finally {
        await host.stop();
    }
});

async function initializeAndListTools(endpoint: string): Promise<string[]> {
    const discovery = await discoverModern(endpoint);
    assert.equal(discovery.status, 200);
    assert.equal(discovery.headers.get("mcp-session-id"), null);

    const listed = await postModern(endpoint, "list-tools", "tools/list");
    assert.equal(listed.status, 200);
    const payload = parseMcpHttpResponse<{
        result?: { tools?: Array<{ name: string }> };
    }>(await listed.text());
    return payload.result?.tools?.map((tool) => tool.name) ?? [];
}

async function callMcpTool(
    endpoint: string,
    name: string,
    args: Record<string, JsonValue>,
): Promise<{
    error?: { code?: number; message?: string };
    result?: {
        _meta?: Record<string, unknown>;
        content?: Array<{ text?: string }>;
        isError?: boolean;
        structuredContent?: unknown;
    };
}> {
    const response = await postModern(endpoint, `call-${name}`, "tools/call", {
        arguments: args,
        name,
    });
    assert.equal(response.status, 200);
    return parseMcpHttpResponse(await response.text());
}

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(
        await readFile(resolve(fixturesDirectory, name), "utf8"),
    ) as JsonValue;
}

function createHost(overrides?: {
    auth?: McpAuthConfig;
    contextTools?: boolean;
    listenPort?: number;
    publicBaseUrl?: string;
    requestLogger?: (line: string) => void;
    storageDir?: string;
    tools?: ToolCallApi;
}): McpHost {
    return new McpHost({
        listenHost: "127.0.0.1",
        listenPort: overrides?.listenPort ?? 0,
        tools: overrides?.contextTools === true ? undefined : overrides?.tools ?? createHttpToolCallApi(),
        ...(overrides?.contextTools !== true ? {} : {
            resolveTarget: () => ({
                async dispatch(request) {
                    if (request.execute !== undefined)
                        return await request.execute(
                            request.callId, request.value.payload, request.value, request.signal,
                        ) as JsonValue;
                    return { exitCode: 0, stderr: "", stdout: "ok\n" };
                },
            }),
        }),
        publicBaseUrl: overrides?.publicBaseUrl,
        requestLogger: overrides?.requestLogger,
        storageDir: overrides?.storageDir,
        instances: [{
            ...createInstance("demo", overrides?.auth ?? { enabled: false, provider: "none" }),
        }],
    });
}

function createInstance(
    name: string,
    auth: McpAuthConfig,
): TestMcpHostInstanceConfig {
    return {
        auth,
        name,
        worker: {
            async appendMcpSessionClosed(_sessionId: string) {},
            async appendMcpSessionOpened(_sessionId: string) {},
            async appendMcpToolCalled(
                _toolName: string,
                _context: { ctxId?: string; requestId?: string },
            ) {},
            snapshot() {
                return { ready: true };
            },
            listTools() {
                return [
                    {
                        requiredCapabilities: ["execute"],
                        group: "bash",
                        name: "bash_run",
                        description: "Run shell",
                        inputSchema: { type: "object" },
                        outputSchema: { type: "object" },
                    },
                ];
            },
            async callTool(
                _toolName: string,
                _input: unknown,
                _context: { source: "mcp" },
            ) {
                return { exitCode: 0, stderr: "", stdout: "ok\n" };
            },
            async prepareWorkspace(workspace: string) {
                return {
                    projectMemoryAgentFile: `${workspace}/AGENT.md`,
                    projectMemoryDirectory: workspace,
                    projectMemoryPresent: false,
                    temporaryDirectory: `${workspace}/tmp`,
                    workspace,
                };
            },
        } as never,
    };
}

function createHttpToolCallApi(): ToolCallApi {
    return {
        async call(
            instance,
            toolName,
            input,
            context,
            _signal,
            transformResult,
            invocationInput,
        ) {
            const callId = "http-test-call";
            const finalValue: ToolCallHookValue = {
                kind: "call",
                toolName,
                payload: input,
                context: { ...context, instance: asInstanceName(instance) },
            };
            const prepared = await invocationInput?.(input, callId, finalValue) ?? input;
            const result = { exitCode: 0, stderr: "", stdout: "ok\n" };
            return await transformResult?.(result, callId) ?? result;
        },
    };
}
