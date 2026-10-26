import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { PassThrough } from "node:stream";

import {
    asInstanceName, Endpoint, Rpc, Stream, StreamChannel, serveToolCallTargetDispatch,
    type JsonValue, type ToolDefinition,
} from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { createAuditRuntime } from "../../../src/audit/index.ts";
import { InstancePaths } from "../../../src/instance/model/Paths.ts";
import { InstanceState } from "../../../src/instance/model/State.ts";
import { WAIT_HANDOFF_MS } from "../../../src/task/wait/index.ts";

test("A to B rewrite executes Goal and detached Wait on destination B over Target Transport", async (t) => {
    const root = await createTestTempDirectory("rewrite-destination");
    const host = new Endpoint({ host: "beta" });
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    const closeTransport = () => { upstream.destroy(); downstream.destroy(); };
    const bridge = new Endpoint({ host: "alpha", connectChannel: async () =>
        new StreamChannel(downstream, upstream, { closeTransport }) });
    const accepting = host.accept(new StreamChannel(upstream, downstream, { closeTransport }));
    await bridge.connect("beta", "tool");
    await accepting;
    const streams = new Stream(host.bind("tool"));
    const workerReads: string[] = [];
    const workerRuns: string[] = [];
    let resolveWait!: () => void;
    const waitResolved = new Promise<void>((resolve) => { resolveWait = resolve; });
    const workers: Array<{ endpoint: Endpoint; rpc: Rpc }> = [];
    const states: InstanceState[] = [];
    t.after(async () => {
        streams.close();
        bridge.close();
        host.close();
        for (const state of states) await state.close();
        for (const worker of workers) { worker.rpc.close(); worker.endpoint.close(); }
        await rm(root, { recursive: true, force: true });
    });
    const definitions: ToolDefinition[] = ["tmux_run", "tmux_read"].map((name) => ({
        name, description: name, group: "tmux", requiredCapabilities: [], inputSchema: { type: "object" }, outputSchema: { type: "object" },
    }));
    const makeState = (name: string) => {
        const instanceName = asInstanceName(name);
        const paths = new InstancePaths(instanceName, root);
        const audit = createAuditRuntime({ instanceName, filePath: paths.auditDatabaseFile, eventBufferSize: 100 });
        const endpoint = new Endpoint({ host: `${name}-worker` });
        const rpc = new Rpc(endpoint.bind("tool"), {
            tmux_run: (payload) => {
                workerRuns.push(name);
                assert.equal((payload as { input: { timeMs: number } }).input.timeMs, WAIT_HANDOFF_MS);
                return { task: { id: "beta-task", status: "running" }, timedOut: true, timeout: 240_000 };
            },
            tmux_read: (payload) => {
                workerReads.push(name);
                assert.equal((payload as { input: { task: string } }).input.task, "beta-task");
                return { waitReason: "terminal", task: { id: "beta-task", status: "completed" } };
            },
        });
        workers.push({ endpoint, rpc });
        let seq = 0;
        const state = new InstanceState({
            acquireLease: () => ({ release() {} }),
            appendEvent: async (type, data) => {
                await audit.api.events.append({ seq: ++seq, type, data, at: new Date().toISOString(), instanceName });
                if (type === "wait.resolved") resolveWait();
            },
            assertReady() {}, audit, endpoint, instanceName, paths,
            config: { approvalPolicy: { mode: "disabled" } } as never,
            prepareWorkspace: async () => { throw new Error("No workspace preparation expected"); },
            readTools: async () => definitions,
            releaseWorkspace: async () => {},
            terminal: {} as never,
        });
        states.push(state);
        state.attachToolCallEndpoint(name === "alpha" ? bridge : host);
        return state;
    };
    const alpha = makeState("alpha");
    const beta = makeState("beta");
    streams.onOpen(async (stream, operation, payload) => {
        assert.equal(operation, "dispatch");
        await serveToolCallTargetDispatch(stream, payload, "beta", (request) => beta.target().dispatch(request));
    });
    alpha.toolCalls.hooks.registerContributor(() => ({
        rewrites: [{ hook: "100-destination", id: "beta", rewrite: (input) =>
            ({ ...input.value, context: { ...input.value.context, instance: asInstanceName("beta") } }) }],
        release() {},
    }));
    const context = { ctxId: "ctx-a", source: "mcp" as const, workspace: root };
    const result = await alpha.toolCalls.api.call("alpha", "workspace_goal", { action: "start", objective: "Destination goal" }, context) as { goal: { instance: string; objective: string } };
    assert.equal(result.goal.objective, "Destination goal");
    assert.equal(await alpha.task.api.goal.read("ctx-a"), undefined);
    assert.equal((await beta.task.api.goal.read("ctx-a"))?.objective, "Destination goal");
    await beta.refreshTools();
    const run = await alpha.toolCalls.api.call("alpha", "tmux_run", { wait: "block", timeMs: 240_000 }, context) as Record<string, JsonValue>;
    assert.equal(run.detached, true);
    assert.equal(run.timedOut, undefined);
    await waitResolved;
    assert.deepEqual(workerRuns, ["beta"]);
    assert.deepEqual(workerReads, ["beta"]);
    assert.deepEqual(await alpha.task.api.wait.list("ctx-a"), []);
    const waits = await beta.task.api.wait.list("ctx-a");
    assert.equal(waits.length, 1);
    assert.equal(waits[0]!.instance, "beta");
    assert.equal(waits[0]!.status, "resolved");
    assert.deepEqual(await alpha.tools.readToolCalls(), []);
    const calls = await beta.tools.readToolCalls();
    assert.deepEqual(calls.map((call) => [call.instance, call.toolName, call.status]), [
        ["beta", "workspace_goal", "completed"], ["beta", "tmux_run", "completed"],
    ]);
});
