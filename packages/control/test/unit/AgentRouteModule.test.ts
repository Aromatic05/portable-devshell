import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRecord, PrefixRouteContext } from "@portable-devshell/shared";

import {
    createAgentRouteModule,
    type AgentControlPort
} from "../../src/control/agent/AgentRouteModule.ts";

const record: AgentRecord = {
    agentId: "ag-1",
    provider: "pi",
    providerVersion: "0.84.4",
    slug: "review",
    state: "running",
    target: { instance: "worker-a", workspace: "/repo" }
};

test("agent routes expose lifecycle control without transcript or tool history", async () => {
    const calls: string[] = [];
    const port: AgentControlPort = {
        async abort(agentId) { calls.push(`abort:${agentId}`); },
        async followUp(input) { calls.push(`followUp:${input.agentId}:${input.message}`); },
        get(agentId) { calls.push(`get:${agentId}`); return record; },
        list() { calls.push("list"); return [record]; },
        async prompt(input) { calls.push(`prompt:${input.agentId}:${input.message}`); },
        async start(input) { calls.push(`start:${input.target}`); return record; },
        async steer(input) { calls.push(`steer:${input.agentId}:${input.message}`); },
        async stop(agentId) { calls.push(`stop:${agentId}`); return { ...record, state: "stopped" }; }
    };
    const module = createAgentRouteModule(port);
    const context = { connectionId: "conn", peer: "cli", requestId: "req" } as PrefixRouteContext;
    const invoke = async (name: string, payload: Record<string, unknown> = {}) => {
        const operation = module.operations.find((candidate) => candidate.name === name);
        if (operation === undefined) throw new Error(`missing agent.${name}`);
        return await operation.handle({ id: name, name, payload: payload as never }, context);
    };

    assert.deepEqual(await invoke("list"), [record]);
    assert.deepEqual(await invoke("start", { target: "worker-a:/repo" }), record);
    await invoke("prompt", { agentId: "ag-1", message: "review" });
    await invoke("steer", { agentId: "ag-1", message: "focus" });
    await invoke("followUp", { agentId: "ag-1", message: "continue" });
    await invoke("abort", { agentId: "ag-1" });
    assert.equal((await invoke("stop", { agentId: "ag-1" }) as unknown as AgentRecord).state, "stopped");

    assert.deepEqual(calls, [
        "list",
        "start:worker-a:/repo",
        "prompt:ag-1:review",
        "steer:ag-1:focus",
        "followUp:ag-1:continue",
        "abort:ag-1",
        "stop:ag-1"
    ]);
});
