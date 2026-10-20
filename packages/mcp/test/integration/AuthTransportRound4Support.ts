import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { asInstanceName } from "@portable-devshell/shared";
import { createAuditRuntime } from "../../../core/src/audit/index.ts";
import { WorkerInstanceTool } from "../../../core/src/toolcall/execution/Tool.ts";
import { ToolCallHistory } from "../../../core/src/toolcall/execution/record/History.ts";
import { WorkerToolCallScheduler } from "../../../core/src/toolcall/execution/Scheduler.ts";
import type { JsonValue, ControlMcpContextMode } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { requireTcpPort } from "../../../../test/TestHttpSupport.ts";
import { McpOAuthProtectedResource } from "../../src/oauth/Route.ts";
import { McpOAuthProviderRuntime } from "../../src/oauth/provider/Provider.ts";
import { McpOAuthApprovalService } from "../../src/oauth/interaction/Approval.ts";
import { McpProtocolRoute } from "../../src/protocol/Route.ts";
import { HttpHost } from "../../src/testing/Http.ts";
import { createTestMcpRuntimeState } from "../ContextRuntime.ts";
import { modernRequestInit, modernRpcRequest } from "./ModernProtocol.ts";
import { Round4MemoryHttp } from "./AuthTransportRound4MemoryHttp.ts";
import { parseMcpHttpResponse } from "../TestMcpHttpResponse.ts";

export const resourceUri = "test://round4/authenticated-resource";
export const config = { requiredScopes: ["mcp"], resourceName: "round4" };
export interface RpcPayload {
    error?: { code: number; message: string; data?: { code?: string } };
    result?: { structuredContent?: Record<string, JsonValue>; isError?: boolean;
        resources?: Array<{ uri: string }>; contents?: Array<{ text: string }> };
}

// TCP by default, explicit memory HTTP simulation when requested. Real Express,
// OIDC/file adapter, MCP, Context, execution scheduler and SQLite audit in both.
// The leaf executor is supplied by each test; no actual Worker process is used.
export async function authFixture(t: TestContext, mode: ControlMcpContextMode = "explicit") {
    const directory = await createTestTempDirectory("round4-auth-transport");
    const simulated = process.env.ROUND4_MCP_TRANSPORT === "memory";
    t.diagnostic(`transport=${simulated ? "memory HTTP simulation (no TCP)" : "loopback TCP"}; Worker=simulated`);
    const http = simulated ? new Round4MemoryHttp() : new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const transportFetch = http instanceof Round4MemoryHttp ? http.fetch : fetch;
    const streamWaiters: Array<() => void> = [];
    const nextStream = () => new Promise<void>((resolve) => { streamWaiters.push(resolve); });
    const send: typeof fetch = async (input, init) => {
        const response = await transportFetch(input, init);
        if (response.headers.get("content-type")?.startsWith("text/event-stream")) streamWaiters.shift()?.();
        return response;
    };
    await http.start();
    const origin = `http://127.0.0.1:${requireTcpPort(http.address)}`;
    const resource = new URL(`${origin}/demo/mcp`);
    const oauth = new McpOAuthProtectedResource(config, origin, directory);
    await oauth.warmup();
    const detachOAuth = oauth.attach(http);
    // Provision fixture credentials through OIDC models sharing the real file
    // adapter with the HTTP provider. No user auth or production state is read.
    const seed = new McpOAuthProviderRuntime({ approvals: new McpOAuthApprovalService(directory), config,
        publicBaseUrl: origin, storageDir: directory });
    const releaseSeed = seed.registerResource(resource, config);
    await seed.warmup();
    const dispatches: Array<{ tool: string; input: JsonValue }> = [];
    const audit = createAuditRuntime({ instanceName: asInstanceName("demo"), filePath: join(directory, "audit.sqlite3"), eventBufferSize: 100 });
    const scheduler = new WorkerToolCallScheduler();
    const execution = new WorkerInstanceTool({ instanceName: asInstanceName("demo"),
        appendEvent: async () => {}, assertReady() {}, logStore: audit.api.logs,
        toolCallHistory: new ToolCallHistory(asInstanceName("demo"), audit.api.toolCalls), toolCallScheduler: scheduler,
        toolInvoker: { async invoke() { throw new Error("Round4 leaf executor must be registered"); } } });
    const runtime = createTestMcpRuntimeState({ contextFile: join(directory, "contexts.jsonl"), storageDir: directory,
        resolveTarget: () => ({ async dispatch(request) {
            dispatches.push({ tool: request.value.toolName, input: request.value.payload });
            return await execution.target().dispatch(request);
        } }) });
    await runtime.contexts.initialize();
    const protocol = new McpProtocolRoute(http, { oauth, publicBaseUrl: origin });
    let reads = 0;
    const mount = (name: string, contextMode = mode) => protocol.registerInstance({
        instanceName: name, contextMode, instanceRoutingEnabled: true,
        auth: { enabled: true, provider: "oauth2", oauth2: config },
        context: runtime.contextTransport, tools: runtime.toolCallRuntime.api, toolSource: runtime.toolSource,
        extensions: [{ id: "round4-resource", resources: [{ uri: resourceUri, name: "Round4", mimeType: "text/plain",
            read() { reads++; return { text: "authenticated fixture resource" }; } }] }] }, `/${name}/mcp`);
    mount("demo");
    mount("other");
    protocol.start();
    t.after(async () => {
        protocol.stop();
        detachOAuth();
        await protocol.drain({ timeoutMs: 3_000 });
        await http.stop();
        releaseSeed();
        runtime.closeContextTools();
        runtime.toolCallRuntime.close();
        await scheduler.close();
        await audit.close();
        await runtime.state.close();
        await runtime.contexts.close();
        await rm(directory, { recursive: true, force: true });
    });
    const form = async (path: string, fields: Record<string, string>) => {
        const response = await send(`${origin}${path}`, { method: "POST", body: new URLSearchParams(fields), signal: AbortSignal.timeout(5_000) });
        const text = await response.text();
        return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, string> };
    };
    const issue = async (label: string, subject = seed.accountId) => {
        const clientId = await seed.registerFirstPartyWebClient(`${origin}/callback-${label}`, ["mcp"]);
        const client = await seed.provider.Client.find(clientId);
        assert.ok(client);
        const grant = new seed.provider.Grant({ accountId: seed.accountId, clientId });
        grant.addResourceScope(resource.href, "mcp");
        const grantId = await grant.save();
        const refresh = new seed.provider.RefreshToken({ accountId: seed.accountId, client, grantId,
            gty: "authorization_code", resource: [resource.href], scope: "mcp offline_access" });
        const issued = await form("/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: await refresh.save() });
        assert.equal(issued.status, 200, JSON.stringify(issued));
        assert.ok(issued.body.access_token);
        if (subject !== seed.accountId) {
            // The embedded issuer has one local owner. Synthetic second-subject
            // access records test the resource boundary, not a multi-user login.
            const token = await seed.provider.AccessToken.find(issued.body.access_token!);
            assert.ok(token);
            const payload = await seed.provider.AccessToken.adapter.find(token.jti);
            assert.ok(payload);
            await seed.provider.AccessToken.adapter.upsert(token.jti, { ...payload, accountId: subject }, 3600);
        }
        return { clientId, grantId, subject, token: issued.body.access_token!, refresh: issued.body.refresh_token! };
    };
    let id = 0;
    const raw = async (token: string | undefined, method: string, params: Record<string, unknown> = {}, path = "/demo/mcp") => {
        const init = modernRequestInit(method, modernRpcRequest(++id, method, params));
        const response = await send(`${origin}${path}`, { ...init,
            headers: { ...init.headers, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, signal: AbortSignal.timeout(5_000) });
        return { status: response.status, headers: response.headers, payload: parseMcpHttpResponse<RpcPayload>(await response.text()) };
    };
    const connect = async (token: string) => {
        const client = new Client({ name: "round4-two-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
        t.after(() => client.close());
        await client.connect(new StreamableHTTPClientTransport(resource, { fetch: send, requestInit: { headers: { authorization: `Bearer ${token}` } } }));
        return client;
    };
    return { nextStream, audit, execution, send, directory, origin, resource, oauth, seed, runtime, protocol, http, mount,
        dispatches, form, issue, raw, connect, resourceReads: () => reads };
}

export function contextId(payload: RpcPayload): string {
    assert.equal(payload.error, undefined, JSON.stringify(payload));
    assert.equal(payload.result?.isError, false, JSON.stringify(payload));
    const ctxId = payload.result?.structuredContent?.ctxId;
    assert.equal(typeof ctxId, "string", JSON.stringify(payload));
    return ctxId as string;
}

export function resourceText(content: unknown): string {
    assert.ok(content !== null && typeof content === "object" && "text" in content);
    assert.equal(typeof content.text, "string");
    return content.text as string;
}
