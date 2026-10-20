import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRemoteError, createToolTransport, runtimeErrorCodes, type JsonValue } from "@portable-devshell/shared";
import { barrier } from "../../../../../core/test/unit/tool/Round4Harness.ts";
import { durableCalls } from "../../../../../core/test/unit/tool/Round6AuditFixture.ts";
import { round4Control } from "./Round4Harness.ts";

const options = { timeout: 15_000 };

test("round6: gated progress callback keeps committed result running until progress is delivered over Control pipes", options, async (t) => {
    const h = await round4Control();
    const path = join(h.directory, "ordered-effect");
    const entered = barrier(); const release = barrier(); t.after(async () => { release.resolve(); await h.close(); });
    const progress: JsonValue[] = [];
    h.runtime.hooks.registerContributor(() => ({ release() {}, rewrites: [{
        hook: "900-progress-gate", id: "progress-gate", async rewrite(input) {
            if (input.direction === "outbound" && input.value.kind === "progress") {
                entered.resolve(); await release.promise;
                return { ...input.value, payload: { visible: "progress" } };
            }
            return input.value;
        },
    }] }));
    h.runtime.hooks.registerExecute("local_effect", async (_id, _input, _value, _signal, emit) => {
        await appendFile(path, "committed\n"); emit?.({ private: "progress" }); return { committed: true };
    });
    const transport = createToolTransport(await h.connect("round6-progress-owner"), "round4");
    const call = transport.callStreaming("local_effect", { original: true }, h.directory, { onProgress: (value) => progress.push(value) });
    await entered.promise;
    assert.equal(await readFile(path, "utf8"), "committed\n"); assert.deepEqual(progress, []);
    const [active] = await transport.listCalls({ ctxId: "round6-progress-owner", status: "running" });
    assert.ok(active); assert.equal(active.output, undefined);
    assert.equal(h.history.hasActiveForContext("round6-progress-owner"), true);
    assert.deepEqual(await durableCalls(h), []);
    release.resolve(); assert.deepEqual(await call, { committed: true });
    assert.deepEqual(progress, [{ visible: "progress" }]);
    const [record] = await durableCalls(h); assert.ok(record);
    assert.equal(record.callId, active.callId); assert.equal(record.status, "completed");
    assert.deepEqual(record.input, { original: true }); assert.deepEqual(record.output, { committed: true });
    assert.equal(await readFile(path, "utf8"), "committed\n");
});

test("round6: disconnecting a streaming observer after commit preserves another peer and both durable outcomes", options, async (t) => {
    const h = await round4Control();
    const path = join(h.directory, "peer-effects");
    const gated = barrier(); const release = barrier(); const finalized = barrier(); t.after(async () => { release.resolve(); await h.close(); });
    h.runtime.hooks.registerContributor((context) => ({
        release() { if (context.ctxId === "round6-disconnected") finalized.resolve(); },
        rewrites: [{ hook: "900-observer-gate", id: "observer-gate", async rewrite(input) {
            if (input.direction === "outbound" && input.value.kind === "result" && context.ctxId === "round6-disconnected") {
                gated.resolve(); await release.promise;
            }
            return input.value;
        } }],
    }));
    h.runtime.hooks.registerExecute("local_effect", async (_id, input) => {
        const token = (input as { token: string }).token;
        await appendFile(path, `${token}\n`); return { token };
    });
    const endpoint = await h.connect("round6-disconnected");
    const lost = createToolTransport(endpoint, "round4").callStreaming("local_effect", { token: "lost" }, h.directory);
    const rejected = assert.rejects(lost);
    await gated.promise; endpoint.close(); await rejected;
    const survivor = createToolTransport(await h.connect("round6-survivor"), "round4");
    assert.deepEqual(await survivor.callStreaming("local_effect", { token: "survivor" }, h.directory), { token: "survivor" });
    release.resolve(); await finalized.promise;
    const records = await survivor.listCalls(); assert.equal(records.length, 2);
    assert.deepEqual(new Set(records.map(({ ctxId }) => ctxId)), new Set(["round6-disconnected", "round6-survivor"]));
    for (const record of records) {
        assert.equal(record.status, "completed"); assert.equal(h.history.hasActiveForContext(record.ctxId!), false);
        assert.deepEqual(record.output, record.input);
    }
    assert.deepEqual(await durableCalls(h), records);
    assert.deepEqual((await readFile(path, "utf8")).trim().split("\n"), ["lost", "survivor"]);
});

test("round6: result adapter failure crosses target IPC with durable execution provenance and no replay", options, async (t) => {
    const h = await round4Control(); t.after(() => h.close());
    const path = join(h.directory, "remote-adapter-effect");
    h.runtime.hooks.registerExecute("local_effect", async () => {
        await appendFile(path, "committed\n"); return { private: "raw result" };
    });
    let adaptedId = "";
    await assert.rejects(h.runtime.api.call("round4", "local_effect", { token: "remote" }, {
        source: "extension", extensionId: "round6.remote", ctxId: "round6-adapter", requestId: "round6-adapter-request", workspace: h.directory,
    }, undefined, async (_result, callId) => {
        adaptedId = callId;
        throw createRemoteError({ code: "round6.remoteAdapter", message: "remote adapter failed", retryable: false });
    }), (error: unknown) => {
        const value = error as { code: string; retryable: boolean; details: { executionCompleted: boolean; failureStage: string } };
        assert.equal(value.code, "round6.remoteAdapter"); assert.equal(value.retryable, false);
        assert.equal(value.details.executionCompleted, true); assert.equal(value.details.failureStage, "postExecution"); return true;
    });
    const transport = createToolTransport(await h.connect("round6-adapter-observer"), "round4");
    const records = await transport.listCalls({ ctxId: "round6-adapter" }); assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.callId, adaptedId); assert.equal(record.error, "round6.remoteAdapter");
    assert.equal(record.executionCompleted, true); assert.equal(record.failureStage, "postExecution");
    assert.equal(record.status, "failed"); assert.equal(record.output, undefined);
    assert.equal(record.extensionId, "round6.remote"); assert.equal(record.requestId, "round6-adapter-request");
    assert.deepEqual(record.input, { token: "remote" });
    assert.deepEqual(await durableCalls(h), records);
    assert.equal(await readFile(path, "utf8"), "committed\n");
    assert.equal(h.history.hasActiveForContext("round6-adapter"), false);
});

test("round6: Review denial across target callback persists origin and reconnect cannot execute the denied request", options, async (t) => {
    const h = await round4Control(); t.after(() => h.close());
    const path = join(h.directory, "denial-effect"); await appendFile(path, "");
    h.runtime.hooks.registerReview({ hook: "500-round6", id: "deny-owner", review(input) {
        return input.direction === "inbound" && input.value.context.ctxId === "round6-denied"
            ? { decision: "reject", reason: "owner denied" } : { decision: "continue" };
    } });
    h.runtime.hooks.registerExecute("local_effect", async () => { await appendFile(path, "allowed\n"); return { allowed: true }; });
    const endpoint = await h.connect("round6-denied");
    const result = await createToolTransport(endpoint, "round4").call("local_effect", { deniedInput: true }, h.directory);
    assert.equal((result as { error: { code: string } }).error.code, runtimeErrorCodes.toolCallRejected);
    assert.equal(await readFile(path, "utf8"), ""); endpoint.close();
    const next = createToolTransport(await h.connect("round6-permitted"), "round4");
    const [denied] = await next.listCalls({ status: "denied" }); assert.ok(denied);
    assert.equal(denied.ctxId, "round6-denied"); assert.equal(denied.workspace, h.directory);
    assert.deepEqual(denied.input, { deniedInput: true }); assert.equal(denied.output, undefined);
    assert.ok(denied.requestId); assert.equal(denied.error, runtimeErrorCodes.toolCallRejected);
    assert.deepEqual(await next.call("local_effect", {}, h.directory), { allowed: true });
    const records = await durableCalls(h); assert.equal(records.length, 2);
    assert.equal(records.filter(({ callId }) => callId === denied.callId).length, 1);
    assert.equal(await readFile(path, "utf8"), "allowed\n");
    assert.equal(h.history.hasActiveForContext("round6-denied"), false);
});
