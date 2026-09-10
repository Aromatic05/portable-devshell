import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHostRecord } from "../../src/builtin/host/AgentHost.ts";
import {
    executeAgentModelCommand,
    type AgentModelProviderPort,
    type AgentModelRuntimePort
} from "../../src/builtin/AgentModelCommand.ts";

function invocation() {
    return {
        context: {
            async instanceReference() { return { current: true }; }
        },
        instance: "worker-a",
        requestId: "model-agent",
        signal: new AbortController().signal,
        workspace: "/repo"
    };
}

function record(agentId: string, instance = "worker-a", workspace = "/repo"): AgentHostRecord {
    return {
        agentId,
        provider: "pi",
        providerVersion: "1.0.0",
        state: "running",
        target: { instance: instance as never, workspace }
    };
}

function fixtures(events: string[]) {
    const records = new Map<string, AgentHostRecord>([
        ["mine", record("mine")],
        ["other", record("other", "worker-b", "/else")]
    ]);
    const runtime: AgentModelRuntimePort = {
        async abort(value) { events.push(`abort:${(value as { agentId: string }).agentId}`); },
        async followUp(value) { events.push(`follow:${(value as { agentId: string }).agentId}`); },
        get(agentId) { return records.get(agentId); },
        list() { return [...records.values()]; },
        async prompt(value) { events.push(`prompt:${(value as { agentId: string }).agentId}`); },
        async reload(value) { events.push(`reload:${(value as { agentId: string }).agentId}`); },
        async start(value) {
            events.push(`start:${JSON.stringify(value)}`);
            const target = (value as { target: string }).target;
            const delimiter = target.indexOf(":");
            const created = record("new", target.slice(0, delimiter), target.slice(delimiter + 1));
            records.set(created.agentId, created);
            return created;
        },
        async steer(value) { events.push(`steer:${(value as { agentId: string }).agentId}`); },
        async stop(value) {
            const agentId = (value as { agentId: string }).agentId;
            events.push(`stop:${agentId}`);
            return records.get(agentId)!;
        },
        async waitForIdle(value) { events.push(`wait:${(value as { agentId: string }).agentId}`); }
    };
    const providers: AgentModelProviderPort = {
        async list() { return []; }
    };
    return { providers, runtime };
}

test("Agent model start is pinned to the authoritative instance/workspace", async () => {
    const events: string[] = [];
    const { providers, runtime } = fixtures(events);
    const result = await executeAgentModelCommand(runtime, providers, ["start", "--provider", "pi"], invocation());
    assert.equal(result.kind, "json");
    assert.equal(events[0], 'start:{"provider":"pi","target":"worker-a:/repo"}');
});

test("Agent model lifecycle cannot control an Agent outside the current Context", async () => {
    const events: string[] = [];
    const { providers, runtime } = fixtures(events);
    const listed = await executeAgentModelCommand(runtime, providers, ["list"], invocation());
    assert.equal(listed.kind, "json");
    assert.deepEqual(listed.kind === "json" ? listed.value : undefined, [{
        agentId: "mine",
        provider: "pi",
        providerVersion: "1.0.0",
        state: "running",
        target: { instance: "worker-a", workspace: "/repo" }
    }]);
    await assert.rejects(
        executeAgentModelCommand(runtime, providers, ["stop", "other"], invocation()),
        /unavailable in the current model Context/u
    );
    assert.deepEqual(events, []);
});

test("Agent model wait blocks through the scoped runtime idle boundary", async () => {
    const events: string[] = [];
    const { providers, runtime } = fixtures(events);
    assert.deepEqual(await executeAgentModelCommand(runtime, providers, ["wait", "mine"], invocation()), {
        kind: "json",
        value: { agentId: "mine", idle: true, webPath: "extensions/agent/" }
    });
    assert.deepEqual(events, ["wait:mine"]);
});
