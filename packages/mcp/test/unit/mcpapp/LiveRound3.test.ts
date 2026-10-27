import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import type { McpHttpRoute } from "../../../src/server/Api.ts";
import { ContextRegistry } from "../../../../control/src/context/registry/index.ts";
import { McpAppLeaseStore } from "../../../src/mcpapp/app/Lease.ts";
import { McpAppPresenceStore } from "../../../src/mcpapp/app/Presence.ts";
import { installMcpAppLive } from "../../../src/mcpapp/app/Live.ts";

type Operation = "snapshot" | "activity" | "image";

async function liveRead(operation: Operation, query = "") {
    const contexts = new ContextRegistry();
    const context = await contexts.create({ principal: "owner", environments: [{ instance: "demo", workspace: "/before" }] });
    const leases = new McpAppLeaseStore();
    const token = await leases.issue("demo", context.ctxId);
    let enter!: () => void;
    let complete!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>();
    const calls: unknown[][] = [];
    const projection = async (...args: unknown[]) => {
        calls.push(args);
        enter();
        await completed;
        return { privateResult: "old-workspace-sensitive-output" };
    };
    const stop = installMcpAppLive({
        instance: "demo", contexts, leases, presence: new McpAppPresenceStore(),
        host: { registerRawRoute(method, path, handler) {
            const key = `${method}:${path}`;
            routes.set(key, handler);
            return () => { routes.delete(key); };
        } } as Pick<McpHttpRoute, "registerRawRoute"> as McpHttpRoute,
        view: { snapshot: projection, activityOutput: projection, activityImage: projection } as never,
    });
    const request = new IncomingMessage(new Socket());
    request.method = "GET";
    request.url = `/api/live/demo/workspace/${operation}?ctxId=${context.ctxId}&callId=call-owned${query}`;
    request.headers = { authorization: `Bearer ${token}`, "if-none-match": '"foreign-context-stale-generation"' };
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const response = new ServerResponse(request);
    response.assignSocket(socket as Socket);
    const finish = once(response, "finish");
    const handler = routes.get(`get:/api/live/demo/workspace/${operation}`);
    assert.ok(handler);
    const handled = handler(request, response);
    return { contexts, context, leases, token, entered, calls,
        async finish() {
            complete();
            await handled;
            await finish;
            const wire = Buffer.concat(chunks).toString("utf8");
            return { status: response.statusCode, body: wire.slice(wire.indexOf("\r\n\r\n") + 4) };
        },
        close() { complete(); stop(); socket.destroy(); request.destroy(); },
    };
}

for (const operation of ["snapshot", "activity", "image"] as const) {
    test(`round3 Live ${operation} withholds an already-computed result after workspace replacement`, async () => {
        const fixture = await liveRead(operation);
        try {
            await fixture.entered;
            await fixture.contexts.attachEnvironment(fixture.context.ctxId, { instance: "demo", workspace: "/after" });
            const result = await fixture.finish();
            assert.equal(result.status, 403);
            assert.equal(result.body.includes("old-workspace-sensitive-output"), false);
            assert.deepEqual(JSON.parse(result.body), { error: "MCP App authorization expired" });
        } finally { fixture.close(); }
    });

    test(`round3 Live ${operation} cannot reuse a revoked bearer after a new capability is issued for the same Context`, async () => {
        const fixture = await liveRead(operation);
        try {
            await fixture.entered;
            await fixture.leases.revokeContext(fixture.context.ctxId);
            const next = await fixture.leases.issue("demo", fixture.context.ctxId);
            assert.notEqual(next, fixture.token);
            const result = await fixture.finish();
            assert.equal(result.status, 401);
            assert.equal(result.body.includes("old-workspace-sensitive-output"), false);
            assert.equal(await fixture.leases.verify("demo", fixture.context.ctxId, next), true);
        } finally { fixture.close(); }
    });
}


test("Activity HTTP 将同一 seq 的字节偏移传给生产 ViewModel", async () => {
    const fixture = await liveRead("activity", "&fromSeq=7&offset=262143");
    try {
        await fixture.entered;
        const result = await fixture.finish();
        assert.equal(result.status, 200);
        assert.deepEqual(fixture.calls, [["demo", fixture.context.ctxId, "call-owned", 7, 262143]]);
    } finally { fixture.close(); }
});

for (const offset of ["-1", "1.5", "01", "1048577", "9007199254740992"]) {
    test(`Activity HTTP 拒绝非法偏移 ${offset} 且不读取日志`, async () => {
        const fixture = await liveRead("activity", `&offset=${offset}`);
        try {
            const result = await fixture.finish();
            assert.equal(result.status, 400);
            assert.equal(fixture.calls.length, 0);
        } finally { fixture.close(); }
    });
}
