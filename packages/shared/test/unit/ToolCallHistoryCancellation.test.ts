import assert from "node:assert/strict";
import test from "node:test";

import { ToolCallViewModel } from "../../src/execution/toolcall/ViewModel.ts";
import { createToolTransport, type ToolTransport } from "../../src/execution/toolcall/Transport.ts";
import type { ToolCallQuery, ToolCallRecord } from "../../src/execution/toolcall/Model.ts";
import { Endpoint } from "../../src/transport/endpoint/Endpoint.ts";
import { Rpc } from "../../src/transport/packet/Rpc.ts";
import { asInstanceName } from "../../src/types/Instance.ts";

const record = (callId: string): ToolCallRecord => ({
    callId, ctxId: "ctx-a", instance: asInstanceName("alpha"), inputSummary: "{}",
    source: "mcp", startedAt: "2026-10-28T00:00:00Z", status: "completed", toolName: "bash_run",
});

for (const scope of ["instance", "context"] as const) {
    for (const cancellation of ["abort", "deadline"] as const) {
        test(`${scope} history forwards ${cancellation} to transport and ignores late pages before retry`, async (t) => {
            t.mock.timers.enable({ apis: ["setTimeout"] });
            let resolvePage!: (calls: ToolCallRecord[]) => void;
            const page = new Promise<ToolCallRecord[]>((resolve) => { resolvePage = resolve; });
            const reads: Array<{ query: ToolCallQuery; signal: AbortSignal | undefined }> = [];
            const transport = {
                listCalls: (query: ToolCallQuery = {}, signal?: AbortSignal) => {
                    if (query.before === undefined) return Promise.resolve([record("head")]);
                    reads.push({ query, signal });
                    return reads.length === 1 ? page : Promise.resolve([record("fresh")]);
                },
                subscribe: async () => ({ close() {}, next: async () => await new Promise<never>(() => {}) }),
            } as unknown as ToolTransport;
            const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
            t.after(() => model.close());
            const load = scope === "instance" ? () => model.load("alpha") : () => model.loadContext("alpha", "ctx-a");
            const older = scope === "instance"
                ? (signal?: AbortSignal) => model.loadOlder("alpha", signal)
                : (signal?: AbortSignal) => model.loadOlderContext("alpha", "ctx-a", signal);
            const state = () => scope === "instance" ? model.state.instances.alpha : model.state.context;
            await load();
            const initial = state();
            const controller = new AbortController();
            const pending = older(controller.signal);
            assert.equal(reads.length, 1);
            const pageSignal = reads[0]!.signal;
            assert.ok(pageSignal instanceof AbortSignal);
            assert.notEqual(pageSignal, controller.signal);
            assert.equal(pageSignal.aborted, false);
            const reason = new Error("Cancelled audit history");
            const rejected = assert.rejects(pending, cancellation === "abort" ? reason : /History read timed out/);
            const cancel = cancellation === "abort"
                ? () => controller.abort(reason)
                : () => t.mock.timers.tick(30_000);
            cancel();
            await rejected;
            assert.equal(pageSignal.aborted, true);
            assert.equal(state()?.calls, initial?.calls);
            assert.equal(state()?.historyBefore, "head");
            assert.equal(state()?.historyExhausted, false);
            assert.equal(state()?.failure?.message,
                scope === "context" && cancellation === "deadline"
                    ? "History read timed out. Retry the operation." : undefined);
            assert.equal(await older(new AbortController().signal), 1);
            const retried = state();
            assert.deepEqual(retried?.calls.map((call) => call.callId).sort(), ["fresh", "head"]);
            assert.equal(retried?.historyBefore, "fresh");
            assert.equal(retried?.historyExhausted, false);
            assert.equal(reads[1]!.query.before, "head");
            assert.equal(reads[1]!.signal?.aborted, false);
            resolvePage([record("stale")]);
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(state(), retried);
        });
    }

    test(`${scope} history still coalesces concurrent reads without a caller signal`, async (t) => {
        let resolvePage!: (calls: ToolCallRecord[]) => void;
        const page = new Promise<ToolCallRecord[]>((resolve) => { resolvePage = resolve; });
        let reads = 0;
        const transport = {
            listCalls: (query: ToolCallQuery = {}) => {
                if (query.before === undefined) return Promise.resolve([record("head")]);
                reads += 1;
                return page;
            },
            subscribe: async () => ({ close() {}, next: async () => await new Promise<never>(() => {}) }),
        } as unknown as ToolTransport;
        const model = new ToolCallViewModel({ cursor: async () => 0, transport: () => transport });
        t.after(() => model.close());
        const load = scope === "instance" ? () => model.load("alpha") : () => model.loadContext("alpha", "ctx-a");
        const older = scope === "instance" ? () => model.loadOlder("alpha") : () => model.loadOlderContext("alpha", "ctx-a");
        await load();
        const first = older();
        const second = older();
        assert.equal(reads, 1);
        resolvePage([record("older")]);
        assert.deepEqual(await Promise.all([first, second]), [1, 1]);
    });
}

test("ToolTransport listCalls abort reaches the active PortClient RPC handler", { timeout: 5000 }, async (t) => {
    const endpoint = new Endpoint({ host: "alpha" });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => { markCancelled = resolve; });
    let handlerSignal!: AbortSignal;
    const payloads: unknown[] = [];
    const rpc = new Rpc(endpoint.bind("tool"), {
        listCalls: (payload, context) => {
            payloads.push(payload);
            handlerSignal = context.signal;
            markStarted();
            return new Promise<ToolCallRecord[]>((resolve) => {
                context.signal.addEventListener("abort", () => {
                    markCancelled();
                    resolve([]);
                }, { once: true });
            });
        },
    });
    t.after(() => { rpc.close(); endpoint.close(); });
    const transport = createToolTransport(endpoint, "alpha");
    const controller = new AbortController();
    const reason = new Error("Stop pending audit RPC");
    const pending = transport.listCalls({ before: "head", limit: 200 }, controller.signal);
    const rejected = assert.rejects(pending, reason);
    await started;
    assert.equal(handlerSignal.aborted, false);
    controller.abort(reason);
    await rejected;
    await cancelled;
    assert.equal(handlerSignal.aborted, true);
    assert.deepEqual(payloads, [{ before: "head", limit: 200 }]);
});
