import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    parseExtensionManifest,
    type ExtensionContext,
    type ExtensionWorkerSession
} from "@portable-devshell/extension";
import type { CliNativeCommandInvocationContext } from "@portable-devshell/extension/cli";

import { executeAgentCommand, type AgentProviderCommandPort } from "../../src/builtin/AgentCommand.ts";
import { AgentExtensionRuntime } from "../../src/builtin/AgentRuntime.ts";
import { activate, deactivate } from "../../src/builtin/index.ts";
import type { AgentProvider, AgentProviderHandle, AgentProviderStartContext } from "../../src/builtin/provider/AgentProvider.ts";

const neverClosed = new Promise<void>(() => undefined);

test("Agent Extension manifest declares host-managed capabilities and domain Extension Points", async () => {
    const manifest = parseExtensionManifest(JSON.parse(
        await readFile(new URL("../../src/builtin/devshell-extension.json", import.meta.url), "utf8")
    ));
    assert.equal(manifest.id, "agent");
    assert.equal(manifest.entry, "index.ts");
    assert.equal(manifest.apiVersion, 4);
    assert.deepEqual(manifest.capabilities, ["assets", "processes", "workers"]);
    assert.deepEqual(manifest.extensions, {
        "cli.native-commands": [{
            id: "agent",
            summary: "Run and manage Agent providers",
            title: "Agent",
            usage: "agent <command>"
        }],
        "cli.model-commands": [{
            id: "agent",
            summary: "Run and interact with Agents in the current model Workspace",
            title: "Agent",
            usage: "agent <command>"
        }],
        "web.applications": [{ id: "agent", title: "Agent" }]
    });
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
    assert.equal(starts[0]?.runtime.agentDirectory, "/state/extensions/agent");

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

test("Agent Extension retires an Agent when its host-owned Worker session closes", async () => {
    const events: string[] = [];
    const workerClosures = new Map<string, () => void>();
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
    const runtime = new AgentExtensionRuntime(extensionContext({ events, workerClosures }), { providers: [provider] });
    const first = await runtime.start({ provider: "test", target: "worker-a:/one" });
    const second = await runtime.start({ provider: "test", target: "worker-b:/two" });

    workerClosures.get("worker-a")?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
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
    const providers = providerCommandFixture(events);
    const invocation = invocationContext();

    const help = await executeAgentCommand(runtime, providers, ["--help"], invocation);
    assert.equal(help.kind, "text");
    if (help.kind === "text") assert.match(help.text, /devshell agent .*<instance:\/workspace>/u);

    const started = await executeAgentCommand(runtime, providers, ["--provider", "test", "worker-a:/repo"], invocation);
    assert.equal(started.kind, "json");
    if (started.kind !== "json" || typeof started.value !== "object" || started.value === null || Array.isArray(started.value)) {
        throw new Error("Agent start command did not return a JSON object.");
    }
    const agentId = String(started.value.agentId);
    assert.equal(started.value.webPath, "extensions/agent/");

    await executeAgentCommand(runtime, providers, ["send", agentId, "continue", "review"], invocation);
    await executeAgentCommand(runtime, providers, ["steer", agentId, "focus"], invocation);
    await executeAgentCommand(runtime, providers, ["follow-up", agentId, "finish"], invocation);
    await executeAgentCommand(runtime, providers, ["abort", agentId], invocation);
    await executeAgentCommand(runtime, providers, ["reload", agentId], invocation);
    const listed = await executeAgentCommand(runtime, providers, ["list"], invocation);
    assert.equal(listed.kind, "json");
    const web = await executeAgentCommand(runtime, providers, ["web"], invocation);
    assert.deepEqual(web, { kind: "json", value: { available: true, webPath: "extensions/agent/" } });
    await executeAgentCommand(runtime, providers, ["stop", agentId], invocation);

    assert.equal(events.includes("provider.prompt:continue review"), true);
    assert.equal(events.includes("provider.steer:focus"), true);
    assert.equal(events.includes("provider.followUp:finish"), true);
    assert.equal(events.includes("provider.abort"), true);
    assert.equal(events.includes("provider.reload"), true);
    await assert.rejects(
        () => executeAgentCommand(runtime, providers, ["--unknown", "worker-a:/repo"], invocation),
        /Unknown agent option/u
    );
});

test("Agent provider mutations require local-owner Extension command authority", async () => {
    const events: string[] = [];
    const runtime = new AgentExtensionRuntime(extensionContext({ events }));
    const providers = providerCommandFixture(events);

    await assert.rejects(
        () => executeAgentCommand(runtime, providers, ["provider", "install", "/provider.dsprovider"], invocationContext(false)),
        /local owner/u
    );
    const installed = await executeAgentCommand(
        runtime,
        providers,
        ["provider", "install", "/provider.dsprovider"],
        invocationContext(true)
    );
    assert.equal(installed.kind, "json");
    assert.equal(events.includes("provider.install:/provider.dsprovider"), true);
});

test("Agent Extension activation binds CLI and Web points without a generic RPC surface", async () => {
    const registrations: Array<{ binding: unknown; id: string; pointId: string }> = [];
    await activate(extensionContext({ events: [], registrations }));
    try {
        assert.deepEqual(
            registrations.map(({ id, pointId }) => `${pointId}/${id}`).sort(),
            ["cli.model-commands/agent", "cli.native-commands/agent", "web.applications/agent"]
        );
        assert.equal(typeof registrations.find(({ pointId }) => pointId === "cli.model-commands")?.binding, "function");
        assert.equal(typeof registrations.find(({ pointId }) => pointId === "cli.native-commands")?.binding, "function");
        const web = registrations.find(({ pointId }) => pointId === "web.applications")?.binding as {
            source?: { kind?: string; resolve?: unknown };
        } | undefined;
        assert.equal(web?.source?.kind, "endpoint");
        assert.equal(typeof web?.source?.resolve, "function");
    } finally {
        await deactivate();
    }
});

function extensionContext(options: {
    canonicalWorkspace?: string;
    events: string[];
    registrations?: Array<{ binding: unknown; id: string; pointId: string }>;
    workerClosures?: Map<string, () => void>;
}): ExtensionContext {
    const assets = {
        async installBundle(sourcePath: string) {
            options.events.push(`assets.install:${sourcePath}`);
            return {
                directory: "/data/extensions/agent/bundles/sha256-test",
                generation: `sha256-${"a".repeat(64)}`
            };
        },
        async installDirectory() { throw new Error("not used"); },
        async listBundles() { return []; },
        async removeBundle(generation: string) {
            options.events.push(`assets.remove:${generation}`);
        },
        async resolveBundle(generation: string) {
            return {
                directory: `/data/extensions/agent/bundles/${generation}`,
                generation
            };
        },
        async projectBundle() { throw new Error("not used"); }
    };
    return {
        capabilities: {
            assets,
            processes: {
                async start() { throw new Error("not used"); }
            },
            workers: {
                async openSession(input) {
                    options.events.push(`worker.open:${input.instance ?? ""}:${input.workspace}`);
                    const workspace = options.canonicalWorkspace ?? input.workspace;
                    let closed = false;
                    let resolveClosed!: () => void;
                    const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
                    const instance = input.instance ?? "worker-a";
                    const closeSession = () => {
                        if (closed) return;
                        closed = true;
                        options.events.push(`worker.close:${workspace}`);
                        resolveClosed();
                    };
                    options.workerClosures?.set(instance, closeSession);
                    const session: ExtensionWorkerSession = {
                        closed: closedPromise,
                        environment: {
                            homeDirectory: "/home/dev",
                            platform: { arch: "x64", os: "linux" },
                        },
                        instance,
                        workspace,
                        async callTool(toolName, _input, callOptions = {}) {
                            options.events.push(`worker.call:${toolName}:${callOptions.operationId ?? ""}:${workspace}`);
                            return { ok: true };
                        },
                        async close() {
                            closeSession();
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
        },
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
            dataDirectory: "/data/extensions/agent",
            runtimeDirectory: "/runtime/extensions/agent",
            stateDirectory: "/state/extensions/agent"
        },
        register(point, id, binding) {
            options.registrations?.push({ binding, id, pointId: point.id });
        },
        version: "0.1.0"
    };
}

function providerFixture(starts: AgentProviderStartContext[], events: string[]): AgentProvider {
    let nextAgent = 0;
    return {
        id: "test",
        version: "1",
        async start(context) {
            starts.push(context);
            events.push(`provider.start:${context.agentId}:${context.runtime.agentDirectory}`);
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

function invocationContext(localOwner = true): CliNativeCommandInvocationContext {
    return { localOwner, requestId: "req-1", signal: new AbortController().signal };
}

function providerCommandFixture(events: string[]): AgentProviderCommandPort {
    const record = {
        enabled: true,
        id: "pi",
        lastKnownGoodGeneration: "sha256-test",
        name: "Pi",
        selectedGeneration: "sha256-test",
        state: "ready" as const,
        version: "0.1.0"
    };
    return {
        async disable(id) { events.push(`provider.disable:${id}`); return { ...record, enabled: false, state: "disabled" }; },
        async enable(id) { events.push(`provider.enable:${id}`); return record; },
        async install(sourcePath) { events.push(`provider.install:${sourcePath}`); return record; },
        async list() { return [record]; },
        async remove(id) { events.push(`provider.remove:${id}`); return { id, removed: true }; }
    };
}
