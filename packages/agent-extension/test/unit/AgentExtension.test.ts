import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
    AgentProvider,
    AgentProviderHandle,
    AgentProviderStartContext
} from "@portable-devshell/agentd";
import {
    parseExtensionManifest,
    type ExtensionContext,
    type ExtensionInvocationContext,
    type ExtensionWorkerSession
} from "@portable-devshell/extension";

import { executeAgentCommand } from "../../src/AgentCommand.ts";
import { AgentExtensionRuntime } from "../../src/AgentRuntime.ts";
import { activate } from "../../src/index.ts";

const neverClosed = new Promise<void>(() => undefined);

test("Agent Extension manifest declares only the generic capabilities it contributes", async () => {
    const manifest = parseExtensionManifest(JSON.parse(
        await readFile(new URL("../../devshell-extension.json", import.meta.url), "utf8")
    ));
    assert.equal(manifest.id, "agent");
    assert.equal(manifest.entry, "dist/index.js");
    assert.deepEqual(manifest.capabilities, ["command", "instance-lifecycle", "rpc", "web", "worker"]);
});

test("Agent Extension start opens one canonical Worker session and owns it until stop", async () => {
    const events: string[] = [];
    const starts: AgentProviderStartContext[] = [];
    const context = extensionContext({
        canonicalWorkspace: "/repo/canonical",
        events
    });
    const provider = providerFixture(starts, events);
    const runtime = new AgentExtensionRuntime(context, { providers: [provider] });

    const record = await runtime.start({ provider: "test", target: "worker-a:/repo/requested" });
    assert.equal(record.target.instance, "worker-a");
    assert.equal(record.target.workspace, "/repo/canonical");
    assert.deepEqual(events.slice(0, 2), [
        "worker.open:worker-a:/repo/requested",
        `provider.start:${record.agentId}:/state/extensions/agent`
    ]);
    assert.equal(starts[0]?.tools.tools[0]?.name, "file_read");
    assert.equal(starts[0]?.runtime.agentdDirectory, "/state/extensions/agent");

    assert.deepEqual(
        await starts[0]!.tools.callTool("file_read", { path: "README.md" }, "op-1"),
        { ok: true }
    );
    assert.equal(events.at(-1), "worker.call:file_read:op-1:/repo/canonical");

    await runtime.stop({ agentId: record.agentId });
    assert.deepEqual(events.slice(-2), [`provider.stop:${record.agentId}`, "worker.close:/repo/canonical"]);
});

test("Agent Extension startup failure closes the already acquired Worker session", async () => {
    const events: string[] = [];
    const runtime = new AgentExtensionRuntime(extensionContext({ events }), {
        providers: [{
            id: "broken",
            version: "1",
            async start() {
                events.push("provider.start:broken");
                throw new Error("provider failed");
            }
        }]
    });

    await assert.rejects(
        () => runtime.start({ provider: "broken", target: "worker-a:/repo" }),
        /provider failed/u
    );
    assert.deepEqual(events, [
        "worker.open:worker-a:/repo",
        "provider.start:broken",
        "worker.close:/repo"
    ]);
});

test("Agent Extension retires only Agents bound to the retired instance", async () => {
    const events: string[] = [];
    let nextAgent = 0;
    const provider: AgentProvider = {
        id: "test",
        version: "1",
        async start(context) {
            const agent = `runtime-${++nextAgent}`;
            events.push(`start:${agent}:${context.target.instance}`);
            return handleFixture(context.agentId, events);
        }
    };
    const runtime = new AgentExtensionRuntime(extensionContext({ events }), { providers: [provider] });
    const first = await runtime.start({ provider: "test", target: "worker-a:/one" });
    const second = await runtime.start({ provider: "test", target: "worker-b:/two" });

    await runtime.retireInstance("worker-a");
    assert.equal(runtime.get(first.agentId), undefined);
    assert.notEqual(runtime.get(second.agentId), undefined);
    assert.equal(events.includes("worker.close:/one"), true);
    assert.equal(events.includes("worker.close:/two"), false);

    await runtime.dispose();
    assert.equal(events.includes("worker.close:/two"), true);
});

test("Agent Extension command owns the legacy devshell agent grammar", async () => {
    const events: string[] = [];
    const runtime = new AgentExtensionRuntime(extensionContext({ events }), {
        providers: [providerFixture([], events)]
    });
    const invocation = invocationContext();

    const help = await executeAgentCommand(runtime, ["--help"], invocation);
    assert.equal(help.kind, "text");
    if (help.kind === "text") assert.match(help.text, /devshell agent .*<instance:\/workspace>/u);

    const started = await executeAgentCommand(runtime, ["--provider", "test", "worker-a:/repo"], invocation);
    assert.equal(started.kind, "json");
    if (started.kind !== "json" || typeof started.value !== "object" || started.value === null || Array.isArray(started.value)) {
        throw new Error("Agent start command did not return a JSON object.");
    }
    const agentId = String(started.value.agentId);
    assert.equal(started.value.webPath, "extensions/agent/");

    await executeAgentCommand(runtime, ["send", agentId, "continue", "review"], invocation);
    await executeAgentCommand(runtime, ["steer", agentId, "focus"], invocation);
    await executeAgentCommand(runtime, ["follow-up", agentId, "finish"], invocation);
    await executeAgentCommand(runtime, ["abort", agentId], invocation);
    await executeAgentCommand(runtime, ["reload", agentId], invocation);
    const listed = await executeAgentCommand(runtime, ["list"], invocation);
    assert.equal(listed.kind, "json");
    const web = await executeAgentCommand(runtime, ["web"], invocation);
    assert.deepEqual(web, { kind: "json", value: { available: true, webPath: "extensions/agent/" } });
    await executeAgentCommand(runtime, ["stop", agentId], invocation);

    assert.equal(events.includes("provider.prompt:continue review"), true);
    assert.equal(events.includes("provider.steer:focus"), true);
    assert.equal(events.includes("provider.followUp:finish"), true);
    assert.equal(events.includes("provider.abort"), true);
    assert.equal(events.includes("provider.reload"), true);
    await assert.rejects(
        () => executeAgentCommand(runtime, ["--unknown", "worker-a:/repo"], invocation),
        /Unknown agent option/u
    );
});

test("Agent Extension activation exposes business RPC but no internal toolSession operations", async () => {
    const activation = await activate(extensionContext({ events: [] }));
    try {
        assert.deepEqual(Object.keys(activation.rpc ?? {}).sort(), [
            "abort",
            "followUp",
            "get",
            "list",
            "prompt",
            "reload",
            "start",
            "steer",
            "stop"
        ]);
        assert.equal(activation.web?.kind, "proxy");
        assert.equal(typeof activation.command, "function");
        assert.equal(typeof activation.lifecycle?.onInstanceRetire, "function");
    } finally {
        await activation.dispose();
    }
});

function extensionContext(options: {
    canonicalWorkspace?: string;
    events: string[];
}): ExtensionContext {
    return {
        generation: "0.1.0-test",
        id: "agent",
        logger: {
            debug() {},
            error() {},
            info() {},
            warn() {}
        },
        paths: {
            codeDirectory: "/code/extensions/agent",
            runtimeDirectory: "/runtime/extensions/agent",
            stateDirectory: "/state/extensions/agent"
        },
        version: "0.1.0",
        worker: {
            async openSession(input) {
                options.events.push(`worker.open:${input.instance ?? ""}:${input.workspace}`);
                const workspace = options.canonicalWorkspace ?? input.workspace;
                let closed = false;
                const session: ExtensionWorkerSession = {
                    instance: input.instance ?? "worker-a",
                    workspace,
                    async callTool(toolName, _input, callOptions = {}) {
                        options.events.push(`worker.call:${toolName}:${callOptions.operationId ?? ""}:${workspace}`);
                        return { ok: true };
                    },
                    async close() {
                        if (closed) return;
                        closed = true;
                        options.events.push(`worker.close:${workspace}`);
                    },
                    listTools() {
                        return [{
                            description: "Read a file",
                            inputSchema: { type: "object" },
                            name: "file_read"
                        }];
                    }
                };
                return session;
            }
        }
    };
}

function providerFixture(starts: AgentProviderStartContext[], events: string[]): AgentProvider {
    let nextAgent = 0;
    return {
        id: "test",
        version: "1",
        async start(context) {
            starts.push(context);
            events.push(`provider.start:${context.agentId}:${context.runtime.agentdDirectory}`);
            nextAgent += 1;
            return handleFixture(context.agentId, events, nextAgent);
        }
    };
}

function handleFixture(agentId: string, events: string[], _ordinal = 0): AgentProviderHandle {
    return {
        closed: neverClosed,
        async abort() { events.push("provider.abort"); },
        async followUp(message) { events.push(`provider.followUp:${message}`); },
        async prompt(message) { events.push(`provider.prompt:${message}`); },
        async reload() { events.push("provider.reload"); },
        async steer(message) { events.push(`provider.steer:${message}`); },
        async stop() { events.push(`provider.stop:${agentId}`); },
        web: { upstream: new URL("http://127.0.0.1:43123/") }
    };
}

function invocationContext(): ExtensionInvocationContext {
    return { requestId: "req-1", signal: new AbortController().signal };
}
