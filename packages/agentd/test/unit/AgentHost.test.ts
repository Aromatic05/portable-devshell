import assert from "node:assert/strict";
import test from "node:test";

import type {
    AgentProvider,
    AgentProviderStartContext,
    AgentWorkerClient
} from "../../src/provider/AgentProvider.ts";
import { AgentHost } from "../../src/host/AgentHost.ts";
import { AgentProviderRegistry } from "../../src/host/AgentProviderRegistry.ts";
import { parseAgentWorkerTarget } from "../../src/target/AgentWorkerTarget.ts";

test("AgentHost binds provider lifecycle, Worker target, runtime prefix, and Web slug", async () => {
    const starts: AgentProviderStartContext[] = [];
    const stopped: string[] = [];
    const closed: string[] = [];
    const prompts: string[] = [];
    const steers: string[] = [];
    const followUps: string[] = [];
    let aborts = 0;
    const provider: AgentProvider = {
        id: "pi",
        version: "0.84.4",
        async start(context) {
            starts.push(context);
            return {
                async abort() {
                    aborts += 1;
                },
                async followUp(message) {
                    followUps.push(message);
                },
                async prompt(message) {
                    prompts.push(message);
                },
                async steer(message) {
                    steers.push(message);
                },
                async stop() {
                    stopped.push(context.agentId);
                },
                web: { upstream: new URL("http://127.0.0.1:43123/") }
            };
        }
    };
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const host = new AgentHost({
        homeDirectory: "/home/tester",
        idFactory: () => "ag-1234567890abcdef",
        providers: [provider],
        slugFactory: () => "resolve-agent",
        workerFactory: (workerTarget, agentId) => createWorker(workerTarget, agentId, closed)
    });

    const record = await host.start({ provider: "pi", target });

    assert.deepEqual(record, {
        agentId: "ag-1234567890abcdef",
        provider: "pi",
        providerVersion: "0.84.4",
        slug: "resolve-agent",
        state: "running",
        target,
        web: {
            basePath: "/agent/resolve-agent/",
            upstream: "http://127.0.0.1:43123/"
        }
    });
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.agentId, record.agentId);
    assert.equal(starts[0]?.web?.basePath, "/agent/resolve-agent/");
    assert.equal(
        starts[0]?.runtime.prefixDirectory,
        "/home/tester/.devshell/agentd/providers/pi/prefix/0.84.4"
    );
    assert.equal(starts[0]?.worker.target.workspace, "/repo");
    assert.deepEqual(host.list(), [record]);

    await host.prompt(record.agentId, "implement");
    await host.steer(record.agentId, "focus tests");
    await host.followUp(record.agentId, "review after");
    await host.abort(record.agentId);
    assert.deepEqual(prompts, ["implement"]);
    assert.deepEqual(steers, ["focus tests"]);
    assert.deepEqual(followUps, ["review after"]);
    assert.equal(aborts, 1);

    const stoppedRecord = await host.stop(record.agentId);
    assert.equal(stoppedRecord.state, "stopped");
    assert.deepEqual(stopped, [record.agentId]);
    assert.deepEqual(closed, [record.agentId]);
    assert.deepEqual(host.list(), []);
});

test("AgentHost rejects unknown providers and duplicate Web slugs", async () => {
    const provider: AgentProvider = {
        id: "pi",
        version: "1",
        async start() {
            return { async prompt() {}, async stop() {} };
        }
    };
    let nextId = 0;
    const host = new AgentHost({
        idFactory: () => `ag-${++nextId}`,
        providers: [provider],
        workerFactory: (target, agentId) => createWorker(target, agentId, [])
    });
    const target = parseAgentWorkerTarget("worker-a:/repo");

    await assert.rejects(() => host.start({ provider: "missing", target }), /Unknown Agent provider/u);
    await host.start({ provider: "pi", slug: "same", target });
    await assert.rejects(() => host.start({ provider: "pi", slug: "same", target }), /slug already exists/u);
    await host.stopAll();
});

test("AgentProviderRegistry rejects duplicate provider ids", () => {
    const provider: AgentProvider = {
        id: "pi",
        version: "1",
        async start() {
            return { async prompt() {}, async stop() {} };
        }
    };
    assert.throws(() => new AgentProviderRegistry([provider, provider]), /already registered/u);
});

function createWorker(
    target: ReturnType<typeof parseAgentWorkerTarget>,
    agentId: string,
    closed: string[]
): AgentWorkerClient {
    return {
        target,
        async callTool() {
            return {};
        },
        async close() {
            closed.push(agentId);
        },
        async listTools() {
            return [];
        }
    };
}
