import assert from "node:assert/strict";
import test from "node:test";
import { Endpoint, type ContextRecord } from "@portable-devshell/shared";
import { createTestMcpRuntimeState, TestMcpHost } from "../ContextRuntime.ts";
import { parseMcpHttpResponse } from "../TestMcpHttpResponse.ts";
import { postModern } from "./ModernProtocol.ts";
import { HttpHost } from "../../src/testing/Http.ts";
import { McpAppLeaseStore } from "../../src/mcpapp/app/Lease.ts";
import { McpAppPresenceStore } from "../../src/mcpapp/app/Presence.ts";
import { installMcpAppLive } from "../../src/mcpapp/app/Live.ts";
import type { McpAppSnapshot } from "../../src/mcpapp/model/Contract.ts";

function testContextRecord(ctxId: string, instance: string, status: ContextRecord["status"] = "active"): ContextRecord {
    const now = new Date().toISOString();
    return {
        createdAt: now,
        ctxId,
        environments: [{ instance, workspace: "/workspace" }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastAccessedAt: now,
        principal: "local",
        status,
    };
}

test("MCP App Live requires a valid Instance+Context Lease, validates Context and supports CORS watch", async () => {
    const host = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const leases = new McpAppLeaseStore();
    const presence = new McpAppPresenceStore();
    const snapshot: McpAppSnapshot = {
        ctxId: "ctx-a", instance: "demo", cursor: 4, agentBusy: false,
        presentation: { work: [], background: [] },
        modelContext: { content: [], structuredContent: { portableDevshellMcpApp: null } },
        reentry: { pending: false },
    };
    let contextActive = true;
    let unavailable = false;
    let requestedCursor = -1;
    let timelineReads = 0;
    let requestedOutput: [string, string, string, number] | undefined;
    let requestedImage: [string, string, string] | undefined;
    const stop = installMcpAppLive({
        host, instance: "demo", leases, presence,
        contexts: {
            async validateForInstance(ctxId, instance) {
                assert.equal(instance, "demo");
                assert.equal(ctxId, "ctx-a");
                return testContextRecord(ctxId, instance, contextActive ? "active" : "disabled");
            },
        },
        view: {
            async activity(instance, ctxId) {
                assert.equal(instance, "demo");
                assert.equal(ctxId, "ctx-a");
                timelineReads++;
                return [{ callId: "call-a", name: "bash_run", at: "", state: "completed" as const }];
            },
            async activityImage(instance, ctxId, callId) {
                requestedImage = [instance, ctxId, callId];
                return callId === "image-a"
                    ? { imageRef: "stored.png", blake3: "hash", bytes: 68,
                        content: "aGVsbG8=", encoding: "base64" as const, mediaType: "image/png" as const }
                    : undefined;
            },
            async activityOutput(instance, ctxId, callId, fromSeq) {
                requestedOutput = [instance, ctxId, callId, fromSeq ?? 1];
                return callId === "call-a" ? { callId, stdout: "retained output\n", stderr: "" } : undefined;
            },
            async snapshot(instance, ctxId, workspace) {
                if (unavailable) throw new Error("private backend file /secret/path");
                assert.equal(instance, "demo");
                assert.equal(ctxId, "ctx-a");
                assert.equal(workspace, "/workspace");
                return snapshot;
            },
            async watch(_instance, _ctxId, _workspace, cursor) {
                requestedCursor = cursor;
                return { changed: true, cursor: snapshot.cursor, snapshot };
            },
        },
    });
    await host.start();
    try {
        const address = host.address;
        assert.ok(typeof address === "object" && address !== null);
        const base = `http://127.0.0.1:${address.port}/api/live/demo/workspace`;
        const url = `${base}/snapshot?ctxId=ctx-a`;
        assert.equal((await fetch(url)).status, 401);
        const token = await leases.issue("demo", "ctx-a");
        const headers = { Authorization: `Bearer ${token}` };
        assert.equal((await fetch(`${base}/snapshot?ctxId=ctx-b`, { headers })).status, 401);
        const preflight = await fetch(url, {
            method: "OPTIONS",
            headers: { origin: "https://chatgpt.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
        const valid = await fetch(url, { headers });
        assert.equal(valid.status, 200);
        assert.equal(valid.headers.get("cache-control"), "no-store");
        assert.deepEqual(await valid.json(), snapshot);
        assert.equal(presence.has("demo", "ctx-a"), true);

        const watched = await fetch(`${base}/watch?ctxId=ctx-a&cursor=3`, { headers });
        assert.equal(watched.status, 200);
        assert.deepEqual(await watched.json(), { changed: true, cursor: 4, snapshot });
        assert.equal(requestedCursor, 3);
        assert.equal(timelineReads, 0);
        assert.equal((await fetch(`${base}/watch?ctxId=ctx-a&cursor=invalid`, { headers })).status, 400);

        const timelineUrl = `${base}/timeline?ctxId=ctx-a`;
        assert.equal((await fetch(timelineUrl)).status, 401);
        assert.equal((await fetch(`${base}/timeline?ctxId=ctx-b`, { headers })).status, 401);
        const timeline = await fetch(timelineUrl, { headers });
        assert.equal(timeline.status, 200);
        assert.equal(timeline.headers.get("cache-control"), "no-store");
        assert.deepEqual(await timeline.json(), { ctxId: "ctx-a",
            activity: [{ callId: "call-a", name: "bash_run", at: "", state: "completed" }] });
        assert.equal(timelineReads, 1);

        const outputUrl = `${base}/activity?ctxId=ctx-a&callId=call-a&fromSeq=1`;
        assert.equal((await fetch(outputUrl)).status, 401);
        assert.equal((await fetch(`${base}/activity?ctxId=ctx-b&callId=call-a`, { headers })).status, 401);
        assert.equal((await fetch(`${base}/activity?ctxId=ctx-a&callId=call-a&fromSeq=0`, { headers })).status, 400);
        assert.equal((await fetch(`${base}/activity?ctxId=ctx-a&callId=foreign`, { headers })).status, 404);
        const activity = await fetch(outputUrl, { headers });
        assert.equal(activity.status, 200);
        assert.deepEqual(await activity.json(), { callId: "call-a", stdout: "retained output\n", stderr: "" });
        assert.deepEqual(requestedOutput, ["demo", "ctx-a", "call-a", 1]);
        assert.equal(activity.headers.get("cache-control"), "no-store");

        const imageUrl = `${base}/image?ctxId=ctx-a&callId=image-a`;
        assert.equal((await fetch(imageUrl)).status, 401);
        assert.equal((await fetch(`${base}/image?ctxId=ctx-b&callId=image-a`, { headers })).status, 401);
        assert.equal((await fetch(`${base}/image?ctxId=ctx-a`, { headers })).status, 400);
        assert.equal((await fetch(`${base}/image?ctxId=ctx-a&callId=foreign`, { headers })).status, 404);
        const preview = await fetch(imageUrl, { headers });
        assert.equal(preview.status, 200);
        assert.equal(preview.headers.get("cache-control"), "no-store");
        assert.equal((await preview.json() as { content: string }).content, "aGVsbG8=");
        assert.deepEqual(requestedImage, ["demo", "ctx-a", "image-a"]);

        unavailable = true;
        const unavailableResponse = await fetch(url, { headers });
        assert.equal(unavailableResponse.status, 503);
        assert.equal((await unavailableResponse.text()).includes("/secret/path"), false);
        unavailable = false;

        contextActive = false;
        assert.equal((await fetch(url, { headers })).status, 403);
        assert.equal((await fetch(outputUrl, { headers })).status, 403);
        assert.equal((await fetch(imageUrl, { headers })).status, 403);
        contextActive = true;
        await leases.revokeInstance("demo");
        assert.equal((await fetch(url, { headers })).status, 401);
        assert.equal((await fetch(outputUrl, { headers })).status, 401);
        assert.equal((await fetch(imageUrl, { headers })).status, 401);

        stop();
        assert.equal((await fetch(url, { headers })).status, 404);
    } finally {
        stop();
        await host.stop();
    }
});

test("successful MCP environ_info returns an Instance-bound private Lease, without exposing the token to the model", async () => {
    let ctxId = "";
    const runtime = createTestMcpRuntimeState({
        endpoint: new Endpoint({ host: "mcpapp-bootstrap-test" }),
        tools: {
            async call(instance, toolName) {
                assert.equal(instance, "demo");
                assert.equal(toolName, "environ_info");
                return { ctxId, instance, status: "active" };
            },
        },
    });
    const host = new TestMcpHost({
        instances: [{ name: "demo" }],
        listenHost: "127.0.0.1",
        listenPort: 0,
        publicBaseUrl: "https://devshell.example.com",
    }, runtime);
    await host.start();
    try {
        const record = await runtime.contexts.registry.create({
            principal: "local",
            environments: [{ instance: "demo", workspace: "/workspace" }],
        });
        ctxId = record.ctxId;
        const address = host.server.address;
        assert.ok(typeof address === "object" && address !== null);
        const endpoint = `http://127.0.0.1:${address.port}/demo/mcp`;
        const call = async () => {
            const response = await postModern(
                endpoint,
                "test-bootstrap",
                "tools/call",
                { arguments: {}, name: "environ_info" },
            );
            assert.equal(response.status, 200);
            return parseMcpHttpResponse<{
                error?: { message?: string };
                result?: { _meta?: Record<string, unknown>; structuredContent?: Record<string, unknown> };
            }>(await response.text());
        };
        const response = await call();
        assert.equal(response.error, undefined);
        const meta = response.result?._meta?.["portable-devshell/mcpapp"] as Record<string, string> | undefined;
        assert.equal(meta?.ctxId, ctxId);
        assert.ok(typeof meta?.token === "string" && meta.token.length >= 16);
        assert.equal(meta?.liveBaseUrl, "https://devshell.example.com/api/live/demo/workspace");
        assert.deepEqual(response.result?.structuredContent, { ctxId, instance: "demo", status: "active" });
        assert.equal(JSON.stringify(response.result?.structuredContent).includes(meta!.token), false);
        assert.equal(await runtime.state.mcpAppLeases.verify("demo", ctxId, meta!.token), true);
        assert.equal(runtime.state.mcpAppPresence.has("demo", ctxId), true);

        const unauthorized = await runtime.contexts.registry.create({
            principal: "different-user", environments: [{ instance: "demo", workspace: "/private" }],
        });
        ctxId = unauthorized.ctxId;
        const rejected = await call();
        // A Live bootstrap failure must not turn a completed ToolCall into an error.
        assert.equal(rejected.error, undefined);
        assert.deepEqual(rejected.result?.structuredContent, {
            ctxId, instance: "demo", status: "active",
        });
        assert.equal(rejected.result?._meta?.["portable-devshell/mcpapp"], undefined);
        assert.equal(runtime.state.mcpAppPresence.has("demo", ctxId), false);
        assert.equal(await runtime.state.mcpAppLeases.verify("demo", ctxId, meta!.token), false);
    } finally {
        await host.stop();
    }
});

test("MCP App bootstrap resolves OpenAI-session Context without making its ID model-visible", async () => {
    const runtime = createTestMcpRuntimeState({
        endpoint: new Endpoint({ host: "mcpapp-openai-session-test" }),
        tools: { async call(instance, toolName) {
            assert.equal(instance, "demo");
            assert.equal(toolName, "environ_info");
            return { instance, status: "active", workspace: "/shared" };
        } },
    });
    const host = new TestMcpHost({
        instances: [{ name: "demo", contextMode: "openai-session" }],
        listenHost: "127.0.0.1", listenPort: 0,
        publicBaseUrl: "https://devshell.example.com",
    }, runtime);
    await host.start();
    try {
        const context = await runtime.contexts.registry.create({
            principal: "local", environments: [{ instance: "demo", workspace: "/shared" }],
        });
        await runtime.contexts.registry.attachEnvironment(context.ctxId,
            { instance: "demo", workspace: "/shared" },
            { principal: "local", bindings: [{ kind: "openai/session", value: "chat-session-mcpapp" }] },
        );
        const address = host.server.address;
        assert.ok(typeof address === "object" && address !== null);
        const response = await postModern(
            `http://127.0.0.1:${address.port}/demo/mcp`,
            "test-openai-session",
            "tools/call",
            {
                arguments: {},
                name: "environ_info",
                _meta: { "openai/session": "chat-session-mcpapp" },
            },
        );
        assert.equal(response.status, 200);
        const payload = parseMcpHttpResponse<{
            error?: { message?: string };
            result?: { _meta?: Record<string, unknown>; structuredContent?: Record<string, unknown> };
        }>(await response.text());
        assert.equal(payload.error, undefined);
        const capability = payload.result?._meta?.["portable-devshell/mcpapp"] as Record<string, string> | undefined;
        assert.equal(capability?.ctxId, context.ctxId);
        assert.equal(await runtime.state.mcpAppLeases.verify("demo", context.ctxId, capability!.token), true);
        assert.equal(payload.result?.structuredContent?.ctxId, undefined);
        assert.equal(JSON.stringify(payload.result?.structuredContent).includes(capability!.token), false);
    } finally {
        await host.stop();
    }
});

test("MCP App Watch denies data after Lease revocation and ends on Instance retirement", async () => {
    const host = new HttpHost({ listenHost: "127.0.0.1", listenPort: 0 });
    const leases = new McpAppLeaseStore();
    const presence = new McpAppPresenceStore();
    let complete!: () => void;
    let entered!: () => void;
    let started = new Promise<void>((resolve) => { entered = resolve; });
    const stop = installMcpAppLive({
        host, instance: "demo", leases, presence,
        contexts: { async validateForInstance(ctxId, instance) {
            return testContextRecord(ctxId, instance);
        } },
        view: {
            async activityOutput() { return undefined; },
            async activityImage() { return undefined; },
            async activity() { return []; },
            async snapshot() { throw new Error("Unexpected snapshot"); },
            async watch(_instance, _ctxId, _workspace, cursor, signal) {
                entered();
                return await new Promise<{ changed: boolean; cursor: number }>((resolve) => {
                    complete = () => resolve({ changed: true, cursor: cursor + 1 });
                    signal?.addEventListener("abort", () => resolve({ changed: false, cursor }), { once: true });
                });
            },
        },
    });
    await host.start();
    try {
        const address = host.address;
        assert.ok(typeof address === "object" && address !== null);
        const url = `http://127.0.0.1:${address.port}/api/live/demo/workspace/watch?ctxId=ctx-a&cursor=1`;
        const token = await leases.issue("demo", "ctx-a");
        const first = fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        await started;
        await leases.revokeInstance("demo");
        complete();
        assert.equal((await first).status, 401);

        const nextToken = await leases.issue("demo", "ctx-a");
        started = new Promise<void>((resolve) => { entered = resolve; });
        const second = fetch(url, { headers: { Authorization: `Bearer ${nextToken}` } });
        await started;
        stop();
        assert.equal((await second).status, 410);
    } finally {
        stop();
        await host.stop();
    }
});

test('MCP App Live cancels only the terminated Context watcher', async () => {
    const host = new HttpHost({ listenHost: '127.0.0.1', listenPort: 0 });
    const leases = new McpAppLeaseStore();
    const presence = new McpAppPresenceStore();
    let enter!: () => void;
    let count = 0;
    const bothEntered = new Promise<void>((resolve) => { enter = resolve; });
    let otherAborted = false;
    const stop = installMcpAppLive({
        host, instance: 'demo', leases, presence,
        contexts: { async validateForInstance(ctxId, instance) {
            return testContextRecord(ctxId, instance);
        } },
        view: {
            async activityOutput() { return undefined; },
            async activityImage() { return undefined; },
            async activity() { return []; },
            async snapshot() { throw new Error('Unexpected snapshot'); },
            async watch(_instance, ctxId, _workspace, cursor, signal) {
                if (++count === 2) enter();
                return await new Promise<{ changed: boolean; cursor: number }>((resolve) => {
                    signal?.addEventListener('abort', () => {
                        if (ctxId === 'ctx-b') otherAborted = true;
                        resolve({ changed: false, cursor });
                    }, { once: true });
                });
            },
        },
    });
    await host.start();
    try {
        const address = host.address;
        assert.ok(typeof address === 'object' && address !== null);
        const base = `http://127.0.0.1:${address.port}/api/live/demo/workspace/watch`;
        const a = await leases.issue('demo', 'ctx-a');
        const b = await leases.issue('demo', 'ctx-b');
        const first = fetch(`${base}?ctxId=ctx-a&cursor=0`, { headers: { Authorization: `Bearer ${a}` } });
        const second = fetch(`${base}?ctxId=ctx-b&cursor=0`, { headers: { Authorization: `Bearer ${b}` } });
        await bothEntered;
        stop.revokeContext('ctx-a');
        assert.equal((await first).status, 410);
        assert.equal(otherAborted, false);
        stop();
        assert.equal((await second).status, 410);
        assert.equal(otherAborted, true);
    } finally {
        stop();
        await host.stop();
    }
});

test('MCP App Domain owns HTTP asset and Live Route lifetime across listener reattachment', async () => {
    const { McpAppRuntime } = await import('../../src/mcpapp/index.ts');
    const { mcpAppAssetDirectory } = await import('../../src/mcpapp/app/Resource.ts');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(mcpAppAssetDirectory);
    const asset = files.find((name) => name.endsWith('.js'));
    assert.ok(asset);
    const host = new HttpHost({ listenHost: '127.0.0.1', listenPort: 0 });
    const runtime = new McpAppRuntime({ endpoint: new Endpoint({ host: 'app-lifecycle-test' }) });
    const contexts = { async validateForInstance(ctxId: string, instance: string) {
        return testContextRecord(ctxId, instance);
    } };
    const first = runtime.attachHost(host, contexts);
    assert.equal(runtime.attachHost(host, contexts), first);
    first.register('demo');
    assert.equal(first.has('demo'), true);
    await host.start();
    try {
        const address = host.address;
        assert.ok(typeof address === 'object' && address !== null);
        const url = `http://127.0.0.1:${address.port}/mcpapp/assets/${asset}`;
        assert.equal((await fetch(url)).status, 200);
        runtime.detachHost(host);
        assert.equal((await fetch(url)).status, 404);
        const second = runtime.attachHost(host, contexts);
        assert.notEqual(second, first);
        second.register('demo');
        assert.equal(second.has('demo'), true);
        assert.equal((await fetch(url)).status, 200);
        runtime.close();
        assert.equal((await fetch(url)).status, 404);
    } finally {
        runtime.close();
        await host.stop();
    }
});
