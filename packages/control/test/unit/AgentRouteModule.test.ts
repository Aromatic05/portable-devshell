import assert from "node:assert/strict";
import test from "node:test";

import { ControlError, type AgentRecord, type PrefixRouteContext } from "@portable-devshell/shared";

import {
    createAgentRouteModule,
    type AgentControlPort
} from "../../src/control/agent/AgentRouteModule.ts";

const record: AgentRecord = {
    agentId: "ag-1",
    provider: "pi",
    providerVersion: "0.84.4",
    state: "running",
    target: { instance: "worker-a", workspace: "/repo" }
};

test("agent routes expose provider lifecycle without transcript history", async () => {
    const calls: string[] = [];
    const port = createPort(calls);
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

test("agent tool sessions require the agent Control peer and preserve operation identity", async () => {
    const calls: string[] = [];
    const module = createAgentRouteModule(createPort(calls));
    const invoke = async (
        peer: PrefixRouteContext["peer"],
        name: string,
        payload: Record<string, unknown>
    ) => {
        const operation = module.operations.find((candidate) => candidate.name === name);
        if (operation === undefined) throw new Error(`missing agent.${name}`);
        let completed: unknown;
        const result = await operation.handle(
            { id: name, name, payload: payload as never },
            {
                afterReply() {},
                connectionId: "agent-conn",
                destination: "@control",
                module: "agent",
                peer,
                requestId: "req",
                signal: new AbortController().signal,
                openStream: async () => ({
                    id: "stream-1",
                    async cancel(error) { throw new Error(error.message); },
                    async complete(value) { completed = value; },
                    async emit() {}
                })
            } satisfies PrefixRouteContext
        );
        return completed ?? result;
    };

    await assert.rejects(
        () => invoke("cli", "toolSessionOpen", { instance: "worker-a", workspace: "/repo" }),
        (error: unknown) => error instanceof ControlError && error.code === "control.clientIdentityInvalid"
    );

    assert.deepEqual(
        await invoke("agent", "toolSessionOpen", { instance: "worker-a", workspace: "/repo" }),
        { sessionId: "ats-1", target: { instance: "worker-a", workspace: "/repo" } }
    );
    assert.deepEqual(
        await invoke("agent", "toolSessionList", { sessionId: "ats-1" }),
        { tools: [] }
    );
    assert.deepEqual(
        await invoke("agent", "toolSessionCall", {
            input: { path: "README.md" },
            operationId: "pi-call-1",
            sessionId: "ats-1",
            toolName: "file_read"
        }),
        { ok: true }
    );
    await invoke("agent", "toolSessionClose", { sessionId: "ats-1" });

    assert.deepEqual(calls, [
        "toolSession.open:agent-conn:worker-a:/repo",
        "toolSession.list:agent-conn:ats-1",
        "toolSession.call:agent-conn:ats-1:pi-call-1:file_read",
        "toolSession.close:agent-conn:ats-1"
    ]);
});

function createPort(calls: string[]): AgentControlPort {
    return {
        async abort(agentId) { calls.push(`abort:${agentId}`); },
        async callToolSession(input, connectionId) {
            calls.push(`toolSession.call:${connectionId}:${input.sessionId}:${input.operationId}:${input.toolName}`);
            return { ok: true };
        },
        async closeToolSession(sessionId, connectionId) {
            calls.push(`toolSession.close:${connectionId}:${sessionId}`);
        },
        async followUp(input) { calls.push(`followUp:${input.agentId}:${input.message}`); },
        get(agentId) { calls.push(`get:${agentId}`); return record; },
        async listToolSessionTools(sessionId, connectionId) {
            calls.push(`toolSession.list:${connectionId}:${sessionId}`);
            return { tools: [] };
        },
        list() { calls.push("list"); return [record]; },
        async openToolSession(input, connectionId) {
            calls.push(`toolSession.open:${connectionId}:${input.instance}:${input.workspace}`);
            return {
                sessionId: "ats-1",
                target: { instance: input.instance, workspace: input.workspace }
            };
        },
        async prompt(input) { calls.push(`prompt:${input.agentId}:${input.message}`); },
        async start(input) { calls.push(`start:${input.target}`); return record; },
        async steer(input) { calls.push(`steer:${input.agentId}:${input.message}`); },
        async stop(agentId) { calls.push(`stop:${agentId}`); return { ...record, state: "stopped" }; }
    };
}
