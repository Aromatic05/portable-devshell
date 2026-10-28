import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { Endpoint, Rpc } from "@portable-devshell/shared";
import { round4Target, barrier } from "../../../../core/test/unit/tool/Round4Harness.ts";
import { registerApprovalToolCallReview } from "../../../../core/src/approval/execution/ToolCallReview.ts";
import { ContextRegistry } from "../../../../control/src/context/registry/index.ts";
import { McpAppLeaseStore } from "../../../src/mcpapp/app/Lease.ts";
import { McpAppPresenceStore } from "../../../src/mcpapp/app/Presence.ts";
import { installMcpAppLive } from "../../../src/mcpapp/app/Live.ts";
import { createMcpAppViewModel, projectMcpAppSnapshot } from "../../../src/mcpapp/ViewModel.ts";
import type { McpHttpRoute } from "../../../src/server/Api.ts";

test("pending runtime original input is private, scoped, and readable over authorized Live before approve", async (t) => {
    const h = await round4Target({}, "alpha");
    t.after(() => h.close());
    const contexts = new ContextRegistry();
    const context = await contexts.create({ principal: "owner", environments: [{ instance: "alpha", workspace: h.directory }] });
    const foreign = await contexts.create({ principal: "other", environments: [{ instance: "alpha", workspace: h.directory }] });
    const leases = new McpAppLeaseStore();
    const token = await leases.issue("alpha", context.ctxId);
    const foreignToken = await leases.issue("alpha", foreign.ctxId);
    const ready = barrier();
    registerApprovalToolCallReview(h.runtime.hooks, { async evaluate(input, signal) {
        const evaluation = await h.approval.evaluate(input, signal);
        ready.resolve();
        return evaluation;
    } });
    let executions = 0;
    h.runtime.hooks.registerExecute("local_effect", async () => { executions++; return {}; });
    const payload = { command: "x".repeat(16000) + "\nTAIL-MCP-PRIVATE" };
    const call = h.runtime.api.call("alpha", "local_effect", payload,
        { source: "mcp", ctxId: context.ctxId, workspace: h.directory });
    await ready.promise;
    const pending = (await h.approval.listPendingApprovals())[0]!;
    const endpoint = new Endpoint({ host: "approval-input-test" });
    endpoint.connect = async (host, port) => endpoint.bind(`client-${port}`).connect(host, port);
    const rpc = new Rpc(endpoint.bind("approval", "alpha"), {
        get: (input) => h.approval.getApproval((input as { approvalId: string }).approvalId) as never,
    });
    t.after(() => { rpc.close(); endpoint.close(); });
    const view = createMcpAppViewModel(endpoint);
    assert.equal(await view.approvalInput("alpha", context.ctxId, "/wrong-workspace", pending.approvalId), undefined);
    const snapshot = projectMcpAppSnapshot({ approvals: { approvals: [pending], lastSeq: 1 },
        ctxId: context.ctxId, workspace: h.directory, instance: "alpha", goal: { goal: null, lastSeq: 1 } });
    assert.equal(snapshot.presentation.primary?.inputAvailable, true);
    assert.equal(snapshot.presentation.primary?.detail?.length, 512);
    assert.equal(JSON.stringify(snapshot).includes("TAIL-MCP-PRIVATE"), false);
    assert.equal(projectMcpAppSnapshot({ approvals: { approvals: [pending], lastSeq: 1 },
        ctxId: context.ctxId, workspace: h.directory, instance: "beta", goal: { goal: null, lastSeq: 1 } }).presentation.primary, undefined);
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>();
    const stop = installMcpAppLive({ contexts, instance: "alpha", leases,
        presence: new McpAppPresenceStore(), view,
        host: { registerRawRoute(method, path, handler) {
            const key = `${method}:${path}`; routes.set(key, handler);
            return () => { routes.delete(key); };
        } } as Pick<McpHttpRoute, "registerRawRoute"> as McpHttpRoute,
    });
    t.after(stop);
    async function read(ctxId: string, bearer?: string) {
        const request = new IncomingMessage(new Socket());
        request.method = "GET";
        request.url = `/api/live/alpha/workspace/approval-input?ctxId=${ctxId}&approvalId=${pending.approvalId}`;
        request.headers = bearer === undefined ? {} : { authorization: `Bearer ${bearer}` };
        const chunks: Buffer[] = [];
        const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
        const response = new ServerResponse(request);
        response.assignSocket(socket as Socket);
        const finished = once(response, "finish");
        await routes.get("get:/api/live/alpha/workspace/approval-input")!(request, response);
        await finished;
        const wire = Buffer.concat(chunks).toString("utf8");
        socket.destroy(); request.destroy();
        return { status: response.statusCode, body: wire.slice(wire.indexOf("\r\n\r\n") + 4) };
    }
    const noToken = await read(context.ctxId);
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.includes("TAIL-MCP-PRIVATE"), false);
    const wrongToken = await read(foreign.ctxId, token);
    assert.equal(wrongToken.status, 401);
    const other = await read(foreign.ctxId, foreignToken);
    assert.equal(other.status, 404);
    assert.equal(other.body.includes("TAIL-MCP-PRIVATE"), false);
    const own = await read(context.ctxId, token);
    assert.equal(own.status, 200);
    assert.equal(JSON.parse(own.body).originalInput, JSON.stringify(payload));
    assert.equal(executions, 0);
    assert.equal((await h.approval.getApproval(pending.approvalId)).status, "pending");
    assert.deepEqual(await h.history.read(), []);
    await h.approval.decideApproval(pending.approvalId, { decision: "approve", decidedBy: "web" });
    await call;
    assert.equal(executions, 1);
    assert.equal((await read(context.ctxId, token)).status, 404);
});
