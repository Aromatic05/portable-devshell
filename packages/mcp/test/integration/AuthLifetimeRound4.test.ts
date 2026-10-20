import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { throwIfToolCallAborted } from "../../../core/src/toolcall/execution/Error.ts";
import type { ToolCallExecutor } from "@portable-devshell/shared";
import { authFixture, contextId, resourceUri, resourceText } from "./AuthTransportRound4Support.ts";

function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}
function bounded<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Round4 causal barrier timed out")), 5_000);
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}
async function install(t: Parameters<typeof authFixture>[0], execute: ToolCallExecutor) {
    const f = await authFixture(t);
    const registration = f.runtime.toolSource.register("demo", [{ name: "beta_wait", group: "beta", description: "Round4 cancellable leaf",
        inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object" }, requiredCapabilities: [] }]);
    const release = f.runtime.toolCallRuntime.hooks.registerExecute("beta_wait", execute);
    t.after(() => { release(); registration.dispose(); });
    const owner = await f.issue("owner");
    const client = await f.connect(owner.token);
    const ctxId = contextId((await f.raw(owner.token, "tools/call", { name: "environ_info", arguments: { workspace: join(f.directory, "work") } })).payload);
    return { ...f, owner, client, ctxId };
}

test("round4 missing explicit Context fails before the execution target even with valid session metadata", async (t) => {
    let executions = 0;
    const f = await install(t, () => { executions++; return { ok: true }; });
    const before = f.dispatches.length;
    const response = await f.raw(f.owner.token, "tools/call", { name: "beta_wait", arguments: {}, _meta: { "openai/session": "do-not-infer" } });
    assert.equal(response.payload.error?.data?.code, "mcp.contextInvalid");
    assert.equal(f.dispatches.length, before);
    assert.equal(executions, 0);
    const own = await f.client.callTool({ name: "beta_wait", arguments: { ctxId: f.ctxId } });
    assert.equal(own.isError, false);
    assert.equal(executions, 1);
});

test("round4 Context disabled during review is reauthorized before execution and durably denied", async (t) => {
    let executions = 0;
    const entered = barrier();
    const proceed = barrier();
    const f = await install(t, () => { executions++; return { ok: true }; });
    const release = f.runtime.toolCallRuntime.hooks.registerReview({ id: "round4-review", hook: "round4-review",
        async review({ direction, value }) {
            if (direction === "inbound" && value.toolName === "beta_wait") { entered.resolve(); await proceed.promise; }
            return { decision: "continue" };
        } });
    t.after(() => { proceed.resolve(); release(); });
    const pending = f.raw(f.owner.token, "tools/call", { name: "beta_wait", arguments: { ctxId: f.ctxId } });
    await bounded(entered.promise);
    await f.runtime.contexts.disable(f.ctxId);
    proceed.resolve();
    const response = await pending;
    assert.equal(response.payload.error?.data?.code, "mcp.contextDisabled");
    assert.equal(executions, 0);
    const records = await f.execution.readToolCalls({ ctxId: f.ctxId });
    assert.equal(records.filter(({ toolName }) => toolName === "beta_wait").length, 1);
    assert.equal(records.find(({ toolName }) => toolName === "beta_wait")?.status, "failed");
});

test("round4 inbound ctxId rewrite cannot cross principal authority at invocation", async (t) => {
    let executions = 0;
    const f = await install(t, () => { executions++; return { ok: true }; });
    const victim = await f.runtime.contexts.registry.create({ principal: "victim", environments: [{ instance: "demo", workspace: join(f.directory, "victim") }] });
    const before = await f.runtime.contexts.registry.lookup(victim.ctxId, { principal: "victim" });
    const release = f.runtime.toolCallRuntime.hooks.registerContributor(() => ({ release() {}, rewrites: [{ id: "round4-substitute", hook: "round4-substitute",
        rewrite({ direction, value }) { return direction === "inbound" && value.toolName === "beta_wait"
            ? { ...value, context: { ...value.context, ctxId: victim.ctxId } } : value; } }] }));
    t.after(release);
    const result = await f.raw(f.owner.token, "tools/call", { name: "beta_wait", arguments: { ctxId: f.ctxId } });
    assert.equal(result.payload.error?.data?.code, "mcp.contextInvalid");
    assert.equal(executions, 0);
    assert.deepEqual(await f.runtime.contexts.registry.lookup(victim.ctxId, { principal: "victim" }), before);
});

test("round4 mid-stream client abort with the execution cancellation contract records cancelled and isolates peer", async (t) => {
    const entered = barrier();
    const aborted = barrier();
    const settled = barrier();
    const releaseLeaf = barrier();
    const f = await install(t, async (_id, _input, _value, signal) => {
        assert.ok(signal);
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await releaseLeaf.promise;
        settled.resolve();
        throwIfToolCallAborted(signal);
        return { ok: true };
    });
    const peer = await f.issue("peer");
    const peerClient = await f.connect(peer.token);
    const streaming = f.nextStream();
    const controller = new AbortController();
    const pending = f.client.callTool({ name: "beta_wait", arguments: { ctxId: f.ctxId } }, { signal: controller.signal });
    const failure = assert.rejects(pending);
    await bounded(entered.promise);
    await bounded(streaming);
    // The request has reached the product target; headers/SSE are produced by
    // the actual Node adapter. Cancellation is client-owned, never forced drain.
    controller.abort(new Error("round4 remote caller cancelled"));
    await failure;
    try { await bounded(aborted.promise); }
    finally { releaseLeaf.resolve(); }
    await bounded(settled.promise);
    assert.equal(resourceText((await peerClient.readResource({ uri: resourceUri })).contents[0]), "authenticated fixture resource");
    await f.protocol.drain({ timeoutMs: 3_000 });
    const record = (await f.execution.readToolCalls({ ctxId: f.ctxId })).find(({ toolName }) => toolName === "beta_wait");
    assert.equal(record?.status, "cancelled");
});

test("round4 revocation blocks subsequent admission while already admitted work completes normally", async (t) => {
    const entered = barrier();
    const proceed = barrier();
    const f = await install(t, async (_id, _input, _value, signal) => {
        entered.resolve(); await proceed.promise; assert.equal(signal?.aborted, false); return { completed: true };
    });
    t.after(proceed.resolve);
    const pending = f.client.callTool({ name: "beta_wait", arguments: { ctxId: f.ctxId } });
    await bounded(entered.promise);
    assert.equal((await f.form("/revoke", { token: f.owner.token, client_id: f.owner.clientId })).status, 200);
    assert.equal((await f.raw(f.owner.token, "resources/list")).status, 401);
    proceed.resolve();
    const result = await pending;
    assert.equal(result.isError, false);
    assert.equal((result.structuredContent as { completed: boolean }).completed, true);
});
