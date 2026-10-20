import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
    createToolTransport, contextErrorCodes, runtimeErrorCodes, type JsonValue,
} from "@portable-devshell/shared";
import { registerApprovalToolCallReview } from "../../../../../core/src/approval/execution/ToolCallReview.ts";
import { installMcpAppAction } from "../../../../../core/src/instance/mcpapp/index.ts";
import { barrier } from "../../../../../core/test/unit/tool/Round4Harness.ts";
import { round4Control } from "./Round4Harness.ts";

test("round4: 32 interleaved calls preserve Context, callback payload, progress and SQLite output", { timeout: 20_000 }, async (t) => {
    const h = await round4Control(); t.after(() => h.close());
    const entered = barrier(); const release = barrier();
    const seen = new Map<string, string>();
    let count = 0;
    h.runtime.hooks.registerExecute("local_effect", async (_id, input, value, _signal, progress) => {
        const token = (input as { token: string }).token;
        seen.set(token, value.context.ctxId!);
        progress?.({ token, phase: "entered" });
        count += 1; if (count === 32) entered.resolve();
        await release.promise;
        return { token, ctxId: value.context.ctxId!, workspace: value.context.workspace! };
    });
    const endpoints = await Promise.all(Array.from({ length: 8 }, (_, i) => h.connect(`round4-context-${i}`)));
    const progress: JsonValue[][] = Array.from({ length: 32 }, () => []);
    const calls = Array.from({ length: 32 }, (_, i) => createToolTransport(endpoints[i % 8]!, "round4")
        .callStreaming("local_effect", { token: `token-${i}` }, `/local/work-${i}`,
            { onProgress: (value) => { progress[i]!.push(value); } }));
    await entered.promise;
    const active = await h.history.read({ status: "running" });
    assert.equal(active.length, 32);
    assert.equal(new Set(active.map((record) => record.callId)).size, 32);
    for (const record of active) assert.equal(h.history.hasActiveForContext(record.ctxId!), true);
    release.resolve();
    const results = await Promise.all(calls);
    for (let i = 0; i < results.length; i += 1) {
        assert.deepEqual(results[i], { token: `token-${i}`, ctxId: `round4-context-${i % 8}`, workspace: `/local/work-${i}` });
        assert.equal(seen.get(`token-${i}`), `round4-context-${i % 8}`);
        assert.deepEqual(progress[i], [{ token: `token-${i}`, phase: "entered" }]);
    }
    const records = await h.history.read();
    assert.equal(records.length, 32);
    for (const record of records) {
        assert.equal(record.status, "completed");
        assert.equal(record.source, "cli");
        assert.deepEqual(record.output, results[Number((record.input as { token: string }).token.slice(6))]);
        assert.equal(h.history.hasActiveForContext(record.ctxId!), false);
    }
});

test("round4: outbound callback failure after a real side effect is terminal and never auto-retried", async (t) => {
    const h = await round4Control(); t.after(() => h.close());
    const path = join(h.directory, "effect.txt");
    h.runtime.hooks.registerExecute("local_effect", async () => { await appendFile(path, "once\n"); return { private: "raw-result" }; });
    h.runtime.hooks.registerContributor(() => ({ release() {}, rewrites: [{
        hook: "900-delivery", id: "fail-result",
        rewrite(input) { if (input.direction === "outbound") throw new Error("private rewrite fault"); return input.value; },
    }] }));
    await assert.rejects(h.runtime.api.call("round4", "local_effect", {}, { source: "cli", ctxId: "effect-context" }), (error: unknown) => {
        const value = error as { code: string; details: Record<string, JsonValue>; retryable: boolean };
        assert.equal(value.code, runtimeErrorCodes.toolResultDeliveryFailed);
        assert.equal(value.retryable, false);
        assert.equal(value.details.executionCompleted, true);
        assert.equal(value.details.failureStage, "outboundHook");
        return true;
    });
    assert.equal(await readFile(path, "utf8"), "once\n");
    const [record] = await h.history.read();
    assert.equal(record?.executionCompleted, true);
    assert.equal(record?.failureStage, "outboundHook");
    assert.equal(record?.status, "failed");
    assert.equal(record?.output, undefined);
    assert.equal(h.history.hasActiveForContext("effect-context"), false);
    const reconnected = createToolTransport(await h.connect("round4-reconnect"), "round4");
    const history = await reconnected.listCalls({ includeInput: true });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.callId, record?.callId);
    assert.equal(await readFile(path, "utf8"), "once\n");
});

test("round4: cancelled persisted approval rejects a late approve and never invokes its executor", async (t) => {
    const h = await round4Control(); t.after(() => h.close());
    const requested = barrier<string>();
    const evaluate = h.approval.evaluate.bind(h.approval);
    registerApprovalToolCallReview(h.runtime.hooks, {
        async evaluate(input, signal) {
            const result = await evaluate(input, signal);
            assert.equal(result.decision, "ask");
            assert.ok(result.decision === "ask"); requested.resolve(result.request.approvalId);
            return result;
        },
    });
    let executions = 0;
    h.runtime.hooks.registerExecute("local_effect", async () => { executions += 1; return {}; });
    const abort = new AbortController();
    const call = h.runtime.api.call("round4", "local_effect", {},
        { source: "cli", ctxId: "cancel-context", workspace: h.directory }, abort.signal);
    const rejected = assert.rejects(call, (error) => {
        assert.equal(error, "caller stopped before approval"); return true;
    });
    const approvalId = await requested.promise;
    abort.abort("caller stopped before approval");
    await rejected;
    await assert.rejects(h.approval.decideApproval(approvalId, { decision: "approve", decidedBy: "cli" }),
        { code: runtimeErrorCodes.approvalAlreadyDecided });
    assert.equal(executions, 0);
    assert.equal((await h.approval.getApproval(approvalId)).status, "cancelled");
    assert.deepEqual(await h.approval.listPendingApprovals("cancel-context"), []);
    // A pre-dispatch cancellation may prevent the target from receiving denied Audit.
    assert.equal(h.history.hasActiveForContext("cancel-context"), false);
});

test("round4: terminal result callback carries rewritten error and execution outcome across IPC", async (t) => {
    const h = await round4Control(); t.after(() => h.close());
    h.runtime.hooks.registerExecute("local_effect", async () => ({ done: true }));
    h.runtime.hooks.registerContributor(() => ({ release() {}, rewrites: [{
        hook: "900-rewrite", id: "to-error", rewrite(input) {
            return input.direction === "outbound" && input.value.kind === "result"
                ? { ...input.value, kind: "error", payload: { error: {
                    code: "test.hostPresentation", message: "Host presentation failed", retryable: false,
                } } } : input.value;
        },
    }] }));
    await assert.rejects(h.runtime.api.call("round4", "local_effect", {}, { source: "cli", ctxId: "rewrite-context" }), (error: unknown) => {
        const value = error as { code: string; details: Record<string, JsonValue> };
        assert.equal(value.code, "test.hostPresentation");
        assert.equal(value.details.executionCompleted, true);
        return true;
    });
    const [record] = await h.history.read();
    assert.equal(record?.status, "failed"); assert.equal(record?.executionCompleted, true);
    assert.equal(record?.error, "test.hostPresentation");
});

test("round4: stale MCP Permission seen pending by Review is revalidated after concurrent cancellation before Execute", async (t) => {
    const h = await round4Control(); t.after(() => h.close());
    const evaluation = await h.approval.evaluate({ callId: "permission-original", source: "mcp",
        ctxId: "permission-context", workspace: h.directory, toolName: "local_effect", inputSummary: "{}" });
    assert.ok(evaluation.decision === "ask");
    registerApprovalToolCallReview(h.runtime.hooks, h.approval);
    // This action exercises only Approval; any accidental Task access must fail.
    const unusedTask = new Proxy({}, { get() { assert.fail("Permission action accessed Task API"); } });
    installMcpAppAction(h.runtime.hooks, { approval: h.approval, task: unusedTask as never });
    const reviewed = barrier(); const release = barrier();
    h.runtime.hooks.registerContributor(() => ({ release() {}, rewrites: [{
        hook: "900-permission-gate", id: "permission-gate", async rewrite(input) {
            if (input.direction === "inbound") { reviewed.resolve(); await release.promise; }
            return input.value;
        },
    }] }));
    const call = h.runtime.api.call("round4", "mcpapp_action", {
        actionId: "approve", itemId: evaluation.request.approvalId, requestId: "round4-permission-action",
    }, { source: "mcp", ctxId: "permission-context", workspace: h.directory });
    const rejected = assert.rejects(call, { code: contextErrorCodes.invalid });
    await reviewed.promise;
    await h.approval.cancel(evaluation.request.approvalId, "original caller cancelled");
    assert.equal((await evaluation.awaitDecision).status, "cancelled");
    release.resolve(); await rejected;
    assert.equal((await h.approval.getApproval(evaluation.request.approvalId)).status, "cancelled");
    const [record] = await h.history.read();
    assert.equal(record?.toolName, "mcpapp_action"); assert.equal(record?.status, "failed");
    assert.equal(record?.error, contextErrorCodes.invalid);
    assert.deepEqual(await h.approval.listPendingApprovals(), []);
});

test("round4: losing an RPC reply after side effect returns uncertainty and reconnect does not replay", async (t) => {
    const h = await round4Control(); t.after(() => h.close());
    const reached = barrier(); const release = barrier(); const terminal = barrier();
    const path = join(h.directory, "reply-loss.txt");
    h.runtime.hooks.registerExecute("local_effect", async () => {
        await appendFile(path, "committed\n"); return { committed: true };
    });
    h.runtime.hooks.registerContributor(() => ({ release() { terminal.resolve(); }, rewrites: [{
        hook: "900-reply-gate", id: "reply-gate", async rewrite(input) {
            if (input.direction === "outbound" && input.value.kind === "result") {
                reached.resolve(); await release.promise;
            }
            return input.value;
        },
    }] }));
    const endpoint = await h.connect("round4-lost-reply");
    const call = createToolTransport(endpoint, "round4").call("local_effect", {}, h.directory);
    const rejected = assert.rejects(call, (error: unknown) => {
        const value = error as { code: string; retryable: boolean };
        assert.equal(value.code, "rpc.resultUncertain"); assert.equal(value.retryable, false); return true;
    });
    await reached.promise;
    assert.equal(await readFile(path, "utf8"), "committed\n");
    endpoint.close(); await rejected;
    release.resolve(); await terminal.promise;
    const records = await createToolTransport(await h.connect("round4-after-loss"), "round4").listCalls();
    assert.equal(records.length, 1); assert.equal(records[0]?.status, "completed");
    assert.deepEqual(records[0]?.output, { committed: true });
    assert.equal(await readFile(path, "utf8"), "committed\n");
});
