import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { ToolCallExecutor } from "../../packages/shared/src/index.ts";
import { authFixture, contextId, resourceUri } from "../../packages/mcp/test/integration/AuthTransportRound4Support.ts";

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

test("round4 client abort mid-stream reaches leaf signal and records cancellation without poisoning another client", async (t) => {
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
        signal.throwIfAborted();
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
    const peerResource = (await peerClient.readResource({ uri: resourceUri })).contents[0];
    assert.ok(peerResource && "text" in peerResource);
    assert.equal(peerResource.text, "authenticated fixture resource");
    await f.protocol.drain({ timeoutMs: 3_000 });
    const record = (await f.execution.readToolCalls({ ctxId: f.ctxId })).find(({ toolName }) => toolName === "beta_wait");
    t.diagnostic(JSON.stringify({ status: record?.status, error: record?.error, failureStage: record?.failureStage, executionCompleted: record?.executionCompleted }));
    assert.equal(record?.status, "cancelled");
});
