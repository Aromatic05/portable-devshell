import assert from "node:assert/strict";
import test from "node:test";

import type {
    AgentProvider,
    AgentProviderStartContext
} from "../../src/provider/AgentProvider.ts";
import { AgentHost } from "../../src/host/AgentHost.ts";
import { AgentProviderRegistry } from "../../src/host/AgentProviderRegistry.ts";
import { parseAgentWorkerTarget } from "../../src/target/AgentWorkerTarget.ts";

const neverClosed = new Promise<void>(() => undefined);

test("AgentHost binds provider lifecycle, target, runtime prefix, and one shared Web endpoint", async () => {
    const starts: AgentProviderStartContext[] = [];
    const stopped: string[] = [];
    const prompts: string[] = [];
    const steers: string[] = [];
    const followUps: string[] = [];
    let aborts = 0;
    let reloads = 0;
    const provider: AgentProvider = {
        id: "pi",
        version: "0.84.4",
        async start(context) {
            starts.push(context);
            return {
                closed: neverClosed,
                async abort() { aborts += 1; },
                async followUp(message) { followUps.push(message); },
                async prompt(message) { prompts.push(message); },
                async reload() { reloads += 1; },
                async steer(message) { steers.push(message); },
                async stop() { stopped.push(context.agentId); },
                web: { upstream: new URL("http://127.0.0.1:43123/") }
            };
        }
    };
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const host = new AgentHost({
        homeDirectory: "/home/tester",
        idFactory: () => "ag-1234567890abcdef",
        providers: [provider]
    });

    const record = await host.start({ provider: "pi", target });

    assert.deepEqual(record, {
        agentId: "ag-1234567890abcdef",
        provider: "pi",
        providerVersion: "0.84.4",
        state: "running",
        target
    });
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.agentId, record.agentId);
    assert.deepEqual(starts[0]?.target, target);
    assert.equal(starts[0]?.web?.basePath, "/agent/");
    assert.equal(
        starts[0]?.runtime.prefixDirectory,
        "/home/tester/.devshell/agentd/providers/pi/prefix/0.84.4"
    );
    assert.equal("worker" in starts[0]!, false);
    assert.deepEqual(host.list(), [record]);
    assert.deepEqual(host.webEndpoint(), {
        basePath: "/agent/",
        upstream: "http://127.0.0.1:43123/"
    });

    await host.prompt(record.agentId, "implement");
    await host.steer(record.agentId, "focus tests");
    await host.followUp(record.agentId, "review after");
    await host.abort(record.agentId);
    await host.reload(record.agentId);
    assert.deepEqual(prompts, ["implement"]);
    assert.deepEqual(steers, ["focus tests"]);
    assert.deepEqual(followUps, ["review after"]);
    assert.equal(aborts, 1);
    assert.equal(reloads, 1);

    const stoppedRecord = await host.stop(record.agentId);
    assert.equal(stoppedRecord.state, "stopped");
    assert.deepEqual(stopped, [record.agentId]);
    assert.deepEqual(host.list(), []);
    assert.equal(host.webEndpoint(), undefined);
});

test("AgentHost rejects reload when the provider does not expose that capability", async () => {
    const host = new AgentHost({
        idFactory: () => "ag-no-reload",
        providers: [{
            id: "minimal",
            version: "1",
            async start() {
                return { closed: neverClosed, async prompt() {}, async stop() {} };
            }
        }]
    });
    const record = await host.start({
        provider: "minimal",
        target: parseAgentWorkerTarget("worker-a:/repo")
    });

    await assert.rejects(
        () => host.reload(record.agentId),
        /does not support reload/u
    );
    await host.stop(record.agentId);
});

test("AgentHost requires one shared provider Web endpoint", async () => {
    let nextId = 0;
    const provider: AgentProvider = {
        id: "pi",
        version: "1",
        async start(context) {
            return {
                closed: neverClosed,
                async prompt() {},
                async stop() {},
                web: { upstream: new URL(`http://127.0.0.1:${43000 + Number(context.agentId.slice(3))}/`) }
            };
        }
    };
    const host = new AgentHost({
        idFactory: () => `ag-${++nextId}`,
        providers: [provider]
    });
    const target = parseAgentWorkerTarget("worker-a:/repo");

    await assert.rejects(() => host.start({ provider: "missing", target }), /Unknown Agent provider/u);
    await host.start({ provider: "pi", target });
    await host.start({ provider: "pi", target });
    assert.throws(() => host.webEndpoint(), /one \/agent hub/u);
    await host.stopAll();
});

test("AgentProviderRegistry rejects duplicate provider ids", () => {
    const provider: AgentProvider = {
        id: "pi",
        version: "1",
        async start() {
            return { closed: neverClosed, async prompt() {}, async stop() {} };
        }
    };
    assert.throws(() => new AgentProviderRegistry([provider, provider]), /already registered/u);
});

test("AgentHost removes a stopped runtime when provider cleanup fails", async () => {
    const provider: AgentProvider = {
        id: "pi",
        version: "1",
        async start() {
            return {
                closed: neverClosed,
                async prompt() {},
                async stop() {
                    throw new Error("provider stop failed");
                }
            };
        }
    };
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const host = new AgentHost({
        idFactory: () => "ag-failing-cleanup",
        providers: [provider]
    });
    const record = await host.start({ provider: "pi", target });

    await assert.rejects(() => host.stop(record.agentId), /provider stop failed/u);
    assert.deepEqual(host.list(), []);
});

test("AgentHost removes a runtime when its provider terminates independently", async () => {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
        close = resolve;
    });
    const provider: AgentProvider = {
        id: "pi",
        version: "1",
        async start() {
            return {
                closed,
                async prompt() {},
                async stop() {}
            };
        }
    };
    const host = new AgentHost({
        idFactory: () => "ag-provider-exit",
        providers: [provider]
    });
    const record = await host.start({
        provider: "pi",
        target: parseAgentWorkerTarget("worker-a:/repo")
    });

    assert.equal(host.get(record.agentId)?.state, "running");
    close();
    await closed;
    await Promise.resolve();

    assert.equal(host.get(record.agentId), undefined);
    assert.deepEqual(host.list(), []);
    await assert.rejects(() => host.prompt(record.agentId, "after exit"), /Unknown Agent/u);
});

test("AgentHost stopAll ignores runtimes that terminate while another Agent is stopping", async () => {
    let closeSecond!: () => void;
    const secondClosed = new Promise<void>((resolve) => {
        closeSecond = resolve;
    });
    let nextId = 0;
    const provider: AgentProvider = {
        id: "pi",
        version: "1",
        async start(context) {
            return context.agentId === "ag-2"
                ? {
                    closed: secondClosed,
                    async prompt() {},
                    async stop() {}
                }
                : {
                    closed: neverClosed,
                    async prompt() {},
                    async stop() {
                        closeSecond();
                        await secondClosed;
                    }
                };
        }
    };
    const host = new AgentHost({
        idFactory: () => `ag-${++nextId}`,
        providers: [provider]
    });
    const target = parseAgentWorkerTarget("worker-a:/repo");
    await host.start({ provider: "pi", target });
    await host.start({ provider: "pi", target });

    await host.stopAll();

    assert.deepEqual(host.list(), []);
});
