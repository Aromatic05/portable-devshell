import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionProcessCapability } from "@portable-devshell/extension";

import type {
    AgentProvider,
    AgentProviderStartContext
} from "../../src/builtin/provider/AgentProvider.ts";
import type { AgentToolSession } from "../../src/builtin/provider/AgentToolSession.ts";
import { AgentHost } from "../../src/builtin/host/AgentHost.ts";
import { AgentProviderRegistry } from "../../src/builtin/provider/AgentProviderRegistry.ts";
import { parseAgentWorkerTarget, type AgentWorkerTarget } from "../../src/builtin/worker/AgentWorkerTarget.ts";

const neverClosed = new Promise<void>(() => undefined);
const runtimeRootDirectory = "/extension-state/agent";
const testProcesses: ExtensionProcessCapability = {
    async start() { throw new Error("process start is not used by AgentHost unit fixtures"); }
};

test("AgentHost binds provider lifecycle, target, runtime prefix, tools, and one shared Web endpoint", async () => {
    const starts: AgentProviderStartContext[] = [];
    const stopped: string[] = [];
    const prompts: string[] = [];
    const steers: string[] = [];
    const followUps: string[] = [];
    let aborts = 0;
    let reloads = 0;
    let waits = 0;
    let toolCloses = 0;
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
                async waitForIdle() { waits += 1; },
                web: { upstream: new URL("http://127.0.0.1:43123/") }
            };
        }
    };
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const tools = toolSession(target, () => { toolCloses += 1; });
    const host = new AgentHost({
        idFactory: () => "ag-1234567890abcdef",
        processes: testProcesses,
        providers: [provider],
        runtimeRootDirectory
    });

    const record = await host.start({ provider: "pi", target, tools });

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
    assert.equal(starts[0]?.tools, tools);
    assert.equal(starts[0]?.web?.basePath, "/agent/");
    assert.equal(
        starts[0]?.runtime.prefixDirectory,
        "/extension-state/agent/providers/pi/prefix/0.84.4"
    );
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
    await host.waitForIdle(record.agentId);
    assert.deepEqual(prompts, ["implement"]);
    assert.deepEqual(steers, ["focus tests"]);
    assert.deepEqual(followUps, ["review after"]);
    assert.equal(aborts, 1);
    assert.equal(reloads, 1);
    assert.equal(waits, 1);

    const stoppedRecord = await host.stop(record.agentId);
    assert.equal(stoppedRecord.state, "stopped");
    assert.deepEqual(stopped, [record.agentId]);
    assert.equal(toolCloses, 1);
    assert.deepEqual(host.list(), []);
    assert.equal(host.webEndpoint(), undefined);
});

test("AgentHost waitForIdle blocks until the provider idle boundary resolves", async () => {
    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const host = new AgentHost({
        idFactory: () => "ag-wait-idle",
        processes: testProcesses,
        providers: [{
            id: "pi",
            version: "1",
            async start() {
                return {
                    closed: neverClosed,
                    async prompt() {},
                    async stop() {},
                    async waitForIdle() { await idle; }
                };
            }
        }],
        runtimeRootDirectory
    });
    const record = await host.start({ provider: "pi", target, tools: toolSession(target) });
    let settled = false;
    const waiting = host.waitForIdle(record.agentId).then(() => { settled = true; });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    resolveIdle();
    await waiting;
    assert.equal(settled, true);
    await host.stop(record.agentId);
});

test("AgentHost closes the tool session when provider startup fails", async () => {
    let closes = 0;
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const host = new AgentHost({
        idFactory: () => "ag-start-failure",
        processes: testProcesses,
        providers: [{
            id: "broken",
            version: "1",
            async start() { throw new Error("provider start failed"); }
        }],
        runtimeRootDirectory
    });

    await assert.rejects(
        () => host.start({ provider: "broken", target, tools: toolSession(target, () => { closes += 1; }) }),
        /provider start failed/u
    );
    assert.equal(closes, 1);
    assert.deepEqual(host.list(), []);
});

test("AgentHost counts a provider as in use while provider startup is still pending", async () => {
    let enteredStart!: () => void;
    let releaseStart!: () => void;
    const entered = new Promise<void>((resolve) => { enteredStart = resolve; });
    const gate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const host = new AgentHost({
        idFactory: () => "ag-starting-provider",
        processes: testProcesses,
        providers: [{
            id: "pi",
            version: "1",
            async start() {
                enteredStart();
                await gate;
                return { closed: neverClosed, async prompt() {}, async stop() {} };
            }
        }],
        runtimeRootDirectory
    });

    const pending = host.start({ provider: "pi", target, tools: toolSession(target) });
    await entered;
    assert.equal(host.isProviderInUse("pi"), true);
    assert.deepEqual(host.list(), []);

    releaseStart();
    const record = await pending;
    assert.equal(host.isProviderInUse("pi"), true);
    await host.stop(record.agentId);
    assert.equal(host.isProviderInUse("pi"), false);
});

test("AgentHost closes the tool session when the requested provider is unavailable", async () => {
    let closes = 0;
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const host = new AgentHost({
        idFactory: () => "ag-missing-provider",
        processes: testProcesses,
        providers: [],
        runtimeRootDirectory
    });

    await assert.rejects(
        host.start({ provider: "missing", target, tools: toolSession(target, () => { closes += 1; }) }),
        /Unknown Agent provider/u
    );
    assert.equal(closes, 1);
    assert.equal(host.isProviderInUse("missing"), false);
});

test("AgentHost rejects reload when the provider does not expose that capability", async () => {
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const host = new AgentHost({
        idFactory: () => "ag-no-reload",
        processes: testProcesses,
        providers: [{
            id: "minimal",
            version: "1",
            async start() {
                return { closed: neverClosed, async prompt() {}, async stop() {} };
            }
        }],
        runtimeRootDirectory
    });
    const record = await host.start({
        provider: "minimal",
        target,
        tools: toolSession(target)
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
        processes: testProcesses,
        providers: [provider],
        runtimeRootDirectory
    });
    const target = parseAgentWorkerTarget("worker-a:/repo");

    await assert.rejects(
        () => host.start({ provider: "missing", target, tools: toolSession(target) }),
        /Unknown Agent provider/u
    );
    await host.start({ provider: "pi", target, tools: toolSession(target) });
    await host.start({ provider: "pi", target, tools: toolSession(target) });
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

test("AgentHost removes a stopped runtime and closes tools when provider cleanup fails", async () => {
    let toolCloses = 0;
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
        processes: testProcesses,
        providers: [provider],
        runtimeRootDirectory
    });
    const record = await host.start({
        provider: "pi",
        target,
        tools: toolSession(target, () => { toolCloses += 1; })
    });

    await assert.rejects(() => host.stop(record.agentId), /provider stop failed/u);
    assert.equal(toolCloses, 1);
    assert.deepEqual(host.list(), []);
});

test("AgentHost removes a runtime and closes tools when its provider terminates independently", async () => {
    let close!: () => void;
    let toolCloses = 0;
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
        processes: testProcesses,
        providers: [provider],
        runtimeRootDirectory
    });
    const target = parseAgentWorkerTarget("worker-a:/repo");
    const record = await host.start({
        provider: "pi",
        target,
        tools: toolSession(target, () => { toolCloses += 1; })
    });

    assert.equal(host.get(record.agentId)?.state, "running");
    close();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(host.get(record.agentId), undefined);
    assert.equal(toolCloses, 1);
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
        processes: testProcesses,
        providers: [provider],
        runtimeRootDirectory
    });
    const target = parseAgentWorkerTarget("worker-a:/repo");
    await host.start({ provider: "pi", target, tools: toolSession(target) });
    await host.start({ provider: "pi", target, tools: toolSession(target) });

    await host.stopAll();

    assert.deepEqual(host.list(), []);
});

function toolSession(
    target: AgentWorkerTarget,
    onClose: () => void = () => undefined
): AgentToolSession {
    let isClosed = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    return {
        closed,
        modelTools: [],
        target,
        tools: [],
        async callTool() { return null; },
        async close() {
            if (isClosed) return;
            isClosed = true;
            onClose();
            resolveClosed();
        }
    };
}
