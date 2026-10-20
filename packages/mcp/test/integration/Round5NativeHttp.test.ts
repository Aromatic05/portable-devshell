import assert from "node:assert/strict";
import { Agent, request } from "node:http";
import { join } from "node:path";
import test from "node:test";
import type { ToolCallExecutor } from "@portable-devshell/shared";
import { throwIfToolCallAborted } from "../../../core/src/toolcall/execution/Error.ts";
import { authFixture, contextId, resourceUri, type RpcPayload } from "./Round5NativeHttpFixture.ts";
import { modernRequestInit, modernRpcHeaders, modernRpcRequest } from "./ModernProtocol.ts";
import { parseMcpHttpResponse } from "../TestMcpHttpResponse.ts";

function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Round5 causal barrier timed out")), 5_000);
        })]);
    } finally { clearTimeout(timer); }
}
async function install(t: Parameters<typeof authFixture>[0], execute: ToolCallExecutor) {
    const f = await authFixture(t);
    const registration = f.runtime.toolSource.register("demo", [{ name: "round5_wait", group: "round5",
        description: "Controlled native HTTP execution leaf", inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object" }, requiredCapabilities: [] }]);
    const release = f.runtime.toolCallRuntime.hooks.registerExecute("round5_wait", execute);
    t.after(() => { release(); registration.dispose(); });
    const owner = await f.issue("owner", "round5-owner");
    const ctxId = contextId((await f.raw(owner.token, "tools/call", { name: "environ_info", arguments: { workspace: join(f.directory, "owner") } })).payload);
    return { ...f, owner, ctxId };
}
function stream(f: Awaited<ReturnType<typeof install>>, token: string, ctxId: string, signal?: AbortSignal) {
    return fetch(f.resource, { ...modernRequestInit("tools/call", modernRpcRequest("overlapping-id", "tools/call", {
        name: "round5_wait", arguments: { ctxId }, _meta: { "openai/session": "overlapping-session" },
    })), headers: { ...modernRpcHeaders("tools/call", { name: "round5_wait" }), authorization: `Bearer ${token}` }, signal });
}

test("round5 REAL_HTTP_INTEGRATION quiet SSE heartbeats are request scoped beside JSON discovery", async (t) => {
    const entered = barrier();
    const proceed = barrier();
    const f = await install(t, async () => { entered.resolve(); await proceed.promise; return { marker: "owner-only" }; });
    t.after(proceed.resolve);
    const pending = stream(f, f.owner.token, f.ctxId, AbortSignal.timeout(8_000));
    await bounded(entered.promise);
    const response = await bounded(pending);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream\b/u);
    assert.equal(response.headers.get("mcp-session-id"), null);
    assert.ok(response.body);
    const reader = response.body.getReader();
    for (let index = 0; index < 2; index++) {
        const frame = await bounded(reader.read());
        assert.equal(frame.done, false);
        assert.match(new TextDecoder().decode(frame.value), /^:/u);
    }
    const peer = await f.issue("peer", "round5-peer");
    const discovery = await f.raw(peer.token, "server/discover");
    assert.equal(discovery.status, 200);
    assert.match(discovery.headers.get("content-type") ?? "", /^application\/json\b/u);
    assert.equal(discovery.headers.get("mcp-session-id"), null);
    proceed.resolve();
    let text = "";
    for (;;) {
        const chunk = await bounded(reader.read());
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
    }
    assert.equal(parseMcpHttpResponse<RpcPayload>(text).result?.structuredContent?.marker, "owner-only");
    await f.protocol.drain({ timeoutMs: 1_000 });
});

test("round5 real HTTP overlapping RPC IDs do not authorize a peer Context toolcall", async (t) => {
    const entered = barrier();
    const proceed = barrier();
    let executions = 0;
    const f = await install(t, async () => { executions++; entered.resolve(); await proceed.promise; return { secret: "owner-output" }; });
    t.after(proceed.resolve);
    const peer = await f.issue("peer", "round5-peer");
    const peerCtx = contextId((await f.raw(peer.token, "tools/call", { name: "environ_info", arguments: { workspace: join(f.directory, "peer") } })).payload);
    const pending = stream(f, f.owner.token, f.ctxId, AbortSignal.timeout(8_000));
    await bounded(entered.promise);
    const stolen = await stream(f, peer.token, f.ctxId, AbortSignal.timeout(5_000));
    const text = await stolen.text();
    assert.equal(parseMcpHttpResponse<RpcPayload>(text).error?.data?.code, "mcp.contextInvalid");
    assert.equal(text.includes("owner-output"), false);
    assert.equal(text.includes(join(f.directory, "owner")), false);
    assert.equal(executions, 1);
    proceed.resolve();
    assert.equal(parseMcpHttpResponse<RpcPayload>(await (await pending).text()).result?.structuredContent?.secret, "owner-output");
    const own = await stream(f, peer.token, peerCtx, AbortSignal.timeout(5_000));
    assert.equal(parseMcpHttpResponse<RpcPayload>(await own.text()).result?.isError, false);
    const records = await f.execution.readToolCalls({ ctxId: peerCtx });
    assert.equal(records.filter(({ toolName }) => toolName === "round5_wait").length, 1);
    assert.equal(executions, 2);
});

for (const [label, patch] of [
    ["prefix scope", { scope: "mcp-admin offline_access" }],
    ["case scope", { scope: "MCP offline_access" }],
    ["missing audience", { aud: [] as string[] }],
    ["namespace lookalike audience", { aud: "http://127.0.0.1/other/mcp" }],
    ["exact-second expiry", { exp: 0 }],
] as const) {
    test(`round5 real HTTP rejects ${label} before resource or Context dispatch`, async (t) => {
        const f = await authFixture(t);
        const owner = await f.issue("owner");
        assert.equal((await f.raw(owner.token, "resources/read", { uri: resourceUri })).status, 200);
        const access = await f.seed.provider.AccessToken.find(owner.token);
        assert.ok(access);
        const original = await f.seed.provider.AccessToken.adapter.find(access.jti);
        assert.ok(original);
        const mutation = label === "exact-second expiry" ? { exp: Math.floor(Date.now() / 1000) } : patch;
        await f.seed.provider.AccessToken.adapter.upsert(access.jti, { ...original, ...mutation }, 3600);
        assert.ok(await f.seed.provider.AccessToken.adapter.find(access.jti));
        const denied = await f.raw(owner.token, "resources/read", { uri: resourceUri });
        assert.equal(denied.status, 401);
        assert.match(denied.headers.get("www-authenticate") ?? "", /Bearer/u);
        assert.equal((await f.raw(owner.token, "tools/call", { name: "environ_info", arguments: { workspace: join(f.directory, "denied") } })).status, 401);
        assert.equal(f.resourceReads(), 1);
        assert.equal(f.dispatches.length, 0);
        assert.deepEqual(await f.runtime.contexts.registry.list(), []);
        await f.protocol.drain({ timeoutMs: 1_000 });
    });
}


for (const [label, header, value] of [
    ["method mismatch", "mcp-method", "resources/list"],
    ["resource-name mismatch", "mcp-name", "test://round5/forged"],
    ["unsupported protocol", "mcp-protocol-version", "1900-01-01"],
] as const) {
    test(`round5 real HTTP ${label} rejects before resource execution and drains`, async (t) => {
        const f = await authFixture(t);
        const owner = await f.issue("owner");
        const init = modernRequestInit("resources/read", modernRpcRequest(1, "resources/read", { uri: resourceUri }));
        const response = await fetch(f.resource, { ...init, headers: { ...init.headers, authorization: `Bearer ${owner.token}`, [header]: value }, signal: AbortSignal.timeout(5_000) });
        assert.equal(response.status, 400);
        assert.ok(parseMcpHttpResponse<RpcPayload>(await response.text()).error);
        assert.equal(f.resourceReads(), 0);
        await f.protocol.drain({ timeoutMs: 1_000 });
        assert.equal((await f.raw(owner.token, "resources/read", { uri: resourceUri })).status, 200);
    });
}

for (const framing of ["malformed-json", "declared-oversize", "chunked-oversize"] as const) {
    test(`round5 real HTTP ${framing} fails at body stage and releases drain accounting`, async (t) => {
        const f = await authFixture(t);
        const owner = await f.issue("owner");
        const agent = new Agent({ keepAlive: true, maxSockets: 1 });
        t.after(() => agent.destroy());
        const body = framing === "malformed-json" ? "{broken" : " ".repeat(16 * 1024 * 1024 + 1);
        const response = await bounded(new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = request(f.resource, { method: "POST", agent, headers: {
                ...modernRpcHeaders("resources/read", { uri: resourceUri }), authorization: `Bearer ${owner.token}`,
                ...(framing === "chunked-oversize" ? { "transfer-encoding": "chunked" } : { "content-length": Buffer.byteLength(body) }),
            } }, (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk: string) => { text += chunk; });
                res.on("error", reject);
                res.on("end", () => resolve({ status: res.statusCode!, body: text }));
            });
            req.on("error", reject);
            req.end(body);
        }));
        assert.equal(response.status, framing === "malformed-json" ? 400 : 413);
        assert.deepEqual(JSON.parse(response.body), { error: framing === "malformed-json"
            ? "Request body must contain valid JSON." : "Request body exceeds 16777216 bytes." });
        assert.equal(f.resourceReads(), 0);
        assert.equal(f.dispatches.length, 0);
        await f.protocol.drain({ timeoutMs: 1_000 });
        assert.equal((await f.raw(owner.token, "resources/read", { uri: resourceUri })).status, 200);
        assert.equal(f.resourceReads(), 1);
    });
}

test("round5 real HTTP interrupted SSE aborts its producer and records cancellation beside healthy peer", async (t) => {
    const entered = barrier();
    const aborted = barrier();
    const proceed = barrier();
    const settled = barrier();
    const f = await install(t, async (_id, _input, _value, signal) => {
        assert.ok(signal);
        signal.addEventListener("abort", aborted.resolve, { once: true });
        entered.resolve();
        await proceed.promise;
        settled.resolve();
        throwIfToolCallAborted(signal);
        return { completed: true };
    });
    t.after(proceed.resolve);
    const controller = new AbortController();
    const pending = stream(f, f.owner.token, f.ctxId, controller.signal);
    await bounded(entered.promise);
    const response = await bounded(pending);
    assert.ok(response.body);
    const reader = response.body.getReader();
    assert.equal((await bounded(reader.read())).done, false);
    const interrupted = assert.rejects(reader.read(), /abort/iu);
    controller.abort();
    await interrupted;
    try { await bounded(aborted.promise); }
    finally { proceed.resolve(); }
    await bounded(settled.promise);
    await f.protocol.drain({ timeoutMs: 1_000 });
    const peer = await f.issue("peer", "round5-peer");
    assert.equal((await f.raw(peer.token, "resources/read", { uri: resourceUri })).status, 200);
    const records = (await f.execution.readToolCalls({ ctxId: f.ctxId })).filter(({ toolName }) => toolName === "round5_wait");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "cancelled");
});

test("round5 real HTTP bearer expiry denies new work without cancelling an admitted SSE producer", async (t) => {
    const entered = barrier();
    const proceed = barrier();
    const f = await install(t, async (_id, _input, _value, signal) => {
        entered.resolve();
        await proceed.promise;
        assert.equal(signal?.aborted, false);
        return { admittedBeforeExpiry: true };
    });
    t.after(proceed.resolve);
    const pending = stream(f, f.owner.token, f.ctxId, AbortSignal.timeout(8_000));
    await bounded(entered.promise);
    const response = await bounded(pending);
    const access = await f.seed.provider.AccessToken.find(f.owner.token);
    assert.ok(access);
    const original = await f.seed.provider.AccessToken.adapter.find(access.jti);
    assert.ok(original);
    await f.seed.provider.AccessToken.adapter.upsert(access.jti, { ...original, exp: Math.floor(Date.now() / 1000) }, 3600);
    assert.equal((await f.raw(f.owner.token, "tools/call", { name: "round5_wait", arguments: { ctxId: f.ctxId } })).status, 401);
    proceed.resolve();
    assert.equal(parseMcpHttpResponse<RpcPayload>(await response.text()).result?.structuredContent?.admittedBeforeExpiry, true);
    await f.protocol.drain({ timeoutMs: 1_000 });
    const records = (await f.execution.readToolCalls({ ctxId: f.ctxId })).filter(({ toolName }) => toolName === "round5_wait");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "completed");
});

test("round5 real HTTP route restart preserves an old SSE response and restores authenticated admission", async (t) => {
    const entered = barrier();
    const proceed = barrier();
    const f = await install(t, async () => { entered.resolve(); await proceed.promise; return { oldGeneration: true }; });
    t.after(proceed.resolve);
    const pending = stream(f, f.owner.token, f.ctxId, AbortSignal.timeout(8_000));
    await bounded(entered.promise);
    const response = await bounded(pending);
    try {
        f.protocol.stop();
        assert.equal((await f.raw(f.owner.token, "resources/list")).status, 404);
    await assert.rejects(f.protocol.drain({ timeoutMs: 10 }), /in-flight response/u);
    f.protocol.start();
    assert.equal((await f.raw(undefined, "resources/list")).status, 401);
    assert.equal((await f.raw(f.owner.token, "resources/read", { uri: resourceUri })).status, 200);
    proceed.resolve();
    assert.equal(parseMcpHttpResponse<RpcPayload>(await response.text()).result?.structuredContent?.oldGeneration, true);
    await f.protocol.drain({ timeoutMs: 1_000 });
    } finally {
        // Release the active response before the fixture's drain/HTTP stop.
        // Node test cleanup hook ordering is not a valid synchronization barrier.
        proceed.resolve();
    }
});
