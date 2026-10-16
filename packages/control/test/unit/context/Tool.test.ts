import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    asInstanceName,
    createToolCallRuntime,
    type EnvironmentTransport,
    type InstanceProcessEnvelope,
    type InstanceRuntimeTransport,
    type JsonValue,
    type ProcessTransport,
} from "@portable-devshell/shared";

import type { ContextApi } from "../../../src/context/Api.ts";
import { createContextRuntime } from "../../../src/context/index.ts";
import {
    contextToolDefinitions,
    installContextTools,
} from "../../../src/context/Public.ts";
import { InstanceChangeHub } from "../../../src/instance/Change.ts";
import {
    createToolCallRegistry,
    type InstanceToolCatalogSource,
} from "../../../src/toolcall/index.ts";

function createBoundRegistry() {
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            dispatch: async (request) => {
                if (request.execute === undefined)
                    throw new Error("no execute registered");
                return (await request.execute(
                    request.callId,
                    request.value.payload,
                    request.value,
                )) as JsonValue;
            },
        }),
    });
    const source: InstanceToolCatalogSource = {
        config: { mcpEnabled: true, name: "local" },
        toolCallHooks: runtime.hooks,
        toolDefinitions: {
            list: () => [],
            register: () => ({ dispose() {}, replace() {} }),
        },
    };
    const registry = createToolCallRegistry();
    const unbind = registry.bind({
        changes: new InstanceChangeHub(),
        instances: {
            list: () => [source],
            onAdding: () => () => undefined,
        },
    });
    return { registry, toolRuntime: runtime, unbind };
}

const environmentTransport: EnvironmentTransport = {
    async prepareExtensionResource(input) {
        assert.deepEqual(input, {
            collection: "managed",
            extensionId: "skill",
        });
        return { directory: "/skills" };
    },
    async prepareWorkspace(workspace) {
        return {
            projectMemoryAgentFile: `${workspace}/AGENTS.md`,
            projectMemoryDirectory: `${workspace}/.agent`,
            temporaryDirectory: "/tmp/context",
            workspace,
        };
    },
    async readAlerts() {
        return { advice: [] };
    },
    async releaseAlerts() {},
    async touchAlerts() {
        return { advice: [] };
    },
    async touchTemporaryDirectory() {},
};

const processTransport: ProcessTransport = {
    async readLogs() {
        return [];
    },
    async refresh() {
        return processEnvelope();
    },
    async snapshot() {
        return processEnvelope();
    },
    async start() {
        throw new Error("unused");
    },
    async stop() {
        throw new Error("unused");
    },
    async subscribe() {
        throw new Error("unused");
    },
};

const instanceRuntimeTransport: InstanceRuntimeTransport = {
    async acquireReference() {
        return {};
    },
    async appendEvent() {},
    async readEvents() {
        throw new Error("unused");
    },
    async releaseReference() {},
    async subscribeEvents() {
        throw new Error("unused");
    },
};

function processEnvelope(): InstanceProcessEnvelope {
    return {
        lastSeq: 0,
        snapshot: {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 0,
            name: asInstanceName("local"),
            ready: true,
            status: "ready",
        },
        worker: {
            capabilities: { cancel: true, streaming: true, tools: true },
            platform: { arch: "x86_64", os: "linux" },
            protocolVersion: "1",
            version: "test",
        },
    };
}

test("Context environ_info exposes only comment and explicit Context identity", () => {
    const definitions = contextToolDefinitions();
    assert.deepEqual(
        definitions.map((definition) => definition.name),
        ["environ_info", "environ_remote"],
    );
    const info = definitions[0]!;
    const output = info.outputSchema as Record<string, JsonValue>;
    const properties = output.properties as Record<string, JsonValue>;
    assert.deepEqual(Object.keys(properties).sort(), ["comment", "ctxId"]);
    assert.deepEqual(output.required, ["comment"]);
});

test("Context registers definitions and executes environ_info through ToolCall hook", async () => {
    const { registry, toolRuntime, unbind } = createBoundRegistry();

    const contextFile = join(
        tmpdir(),
        `portable-devshell-context-${randomUUID()}.jsonl`,
    );
    const runtime = createContextRuntime({
        contextFile,
        environment: () => environmentTransport,
        leaseInstance: () => ({ release() {} }),
        process: () => processTransport,
        runtime: () => instanceRuntimeTransport,
    });
    await runtime.initialize();

    let externalPrincipal: string | undefined;
    let preparedCtxId: string | undefined;
    const baseEnvironment = runtime.api.environment;
    const contexts: ContextApi = {
        cleanup: runtime.api.cleanup,
        disable: (ctxId) => runtime.api.disable(ctxId),
        detachInstance: (instance) => runtime.api.detachInstance(instance),
        environment: {
            attachRemote: (ctxId, handle, workspace, signal) =>
                baseEnvironment.attachRemote(ctxId, handle, workspace, signal),
            ensurePrepared: (ctxId, instance, workspace) =>
                baseEnvironment.ensurePrepared(ctxId, instance, workspace),
            maskRemote: (ctxId, handle) =>
                baseEnvironment.maskRemote(ctxId, handle),
            prepareLocal: async (ctxId, instance, workspace, options) => {
                externalPrincipal = options?.external?.principal;
                preparedCtxId = ctxId;
                return await baseEnvironment.prepareLocal(
                    ctxId,
                    instance,
                    workspace,
                    options,
                );
            },
            rollbackUndisclosed: (ctxId, instance, workspace) =>
                baseEnvironment.rollbackUndisclosed(ctxId, instance, workspace),
        },
        reconcileInstance: (instance) =>
            runtime.api.reconcileInstance(instance),
        registry: runtime.api.registry,
        renew: (ctxId) => runtime.api.renew(ctxId),
        resolve: (input) => runtime.api.resolve(input),
    };

    const uninstall = installContextTools(contexts, registry, {
        environment: () => environmentTransport,
        leaseInstance: () => ({ release() {} }),
        process: () => processTransport,
    });
    try {
        assert.equal(
            registry.get("local", "environ_info")?.definition.name,
            "environ_info",
        );
        const result = await toolRuntime.api.call(
            "local",
            "environ_info",
            { workspace: "/repo" },
            {
                contextMode: "explicit",
                externalBindings: [{ kind: "session", value: "s-1" }],
                principal: "alice",
                source: "mcp",
            },
        );
        const record = result as Record<string, JsonValue>;
        assert.equal(externalPrincipal, "alice");
        assert.ok(preparedCtxId !== undefined && preparedCtxId.length > 0);
        assert.equal(record.ctxId, preparedCtxId);
        assert.deepEqual(record.comment, []);
        assert.deepEqual(Object.keys(record).sort(), ["comment", "ctxId"]);
    } finally {
        uninstall();
        unbind();
        runtime.close();
        await rm(contextFile, { force: true });
    }
    assert.equal(registry.get("local", "environ_info"), undefined);
});

test("repeated environ_info keeps the Context temporary directory and reports its claimed Memory", async () => {
    const { registry, toolRuntime, unbind } = createBoundRegistry();
    const contextFile = join(tmpdir(), `portable-devshell-memory-${randomUUID()}.jsonl`);
    const allocations: Array<string | undefined> = [];
    const testEnvironment: EnvironmentTransport = {
        ...environmentTransport,
        async prepareWorkspace(workspace, previous) {
            allocations.push(previous);
            return {
                projectMemoryAgentFile: `${workspace}/var/agent-work/INDEX.md`,
                projectMemoryDirectory: `${workspace}/var/agent-work`,
                projectMemoryPresent: true,
                temporaryDirectory: previous ?? `/tmp/context-${allocations.length}`,
                workspace,
            };
        },
    };
    const runtime = createContextRuntime({
        contextFile,
        environment: () => testEnvironment,
        leaseInstance: () => ({ release() {} }),
        process: () => processTransport,
        runtime: () => instanceRuntimeTransport,
    });
    let selectedMemory: { directory: string; mailbox: string; name: string } | undefined;
    let firstCtxId: string | undefined;
    await runtime.initialize();
    const uninstall = installContextTools(runtime.api, registry, {
        environment: () => testEnvironment,
        leaseInstance: () => ({ release() {} }),
        memory: async (ctxId) => {
            firstCtxId ??= ctxId;
            return ctxId === firstCtxId ? selectedMemory : undefined;
        },
        modelCommands: () => ["memory"],
        process: () => processTransport,
    });
    const bootstrap = async (session: string) =>
        await toolRuntime.api.call("local", "environ_info", { workspace: "/repo" }, {
            contextMode: "openai-session",
            externalBindings: [{ kind: "openai/session", value: session }],
            principal: "alice",
            source: "mcp",
        }) as Record<string, JsonValue>;
    try {
        const before = await bootstrap("chat-1");
        assert.deepEqual(before.comment, [
            "Memory 未初始化。执行 devshell memory init <name>；接续已有记忆可使用 devshell memory inherit <name>。",
        ]);
        assert.deepEqual(Object.keys(before), ["comment"]);

        selectedMemory = {
            name: "chosen-agent",
            directory: "/repo/var/agent-work/chosen-agent",
            mailbox: "/repo/var/agent-work/chosen-agent/mailbox.md",
        };
        const after = await bootstrap("chat-1");
        assert.deepEqual(after.comment, [`Memory: ${selectedMemory.directory}`]);
        assert.deepEqual(Object.keys(after), ["comment"]);
        assert.deepEqual(allocations.slice(0, 2), [undefined, "/tmp/context-1"]);

        const differentAgent = await bootstrap("chat-2");
        assert.deepEqual(differentAgent.comment, before.comment);
        assert.equal(allocations[2], undefined);
    } finally {
        uninstall();
        unbind();
        runtime.close();
        await rm(contextFile, { force: true });
    }
});

test("environ_info survives Comment Memory failures and timeouts without treating the binding as unclaimed", async () => {
    const { registry, toolRuntime, unbind } = createBoundRegistry();
    const contextFile = join(tmpdir(), `portable-devshell-optional-memory-${randomUUID()}.jsonl`);
    const runtime = createContextRuntime({
        contextFile,
        environment: () => environmentTransport,
        leaseInstance: () => ({ release() {} }),
        process: () => processTransport,
        runtime: () => instanceRuntimeTransport,
    });
    let phase: "unavailable" | "stalled" | "recovered" = "unavailable";
    const selectedMemory = {
        name: "existing-agent",
        directory: "/repo/var/agent-work/existing-agent",
        mailbox: "/repo/var/agent-work/existing-agent/mailbox.md",
    };
    await runtime.initialize();
    const uninstall = installContextTools(runtime.api, registry, {
        environment: () => environmentTransport,
        leaseInstance: () => ({ release() {} }),
        memory: async (_ctxId, _instance, _workspace, signal) => {
            if (phase === "unavailable")
                throw new Error("Comment sandbox unavailable: PRIVATE_PATH");
            if (phase === "stalled")
                return await new Promise<never>((_resolve, reject) => {
                    signal?.addEventListener("abort",
                        () => reject(new Error("Comment status cancelled")), { once: true });
                });
            return selectedMemory;
        },
        modelCommands: () => ["memory"],
        process: () => processTransport,
    });
    const bootstrap = async () => await toolRuntime.api.call(
        "local", "environ_info", { workspace: "/repo" }, {
            contextMode: "openai-session",
            externalBindings: [{ kind: "openai/session", value: "existing-chat" }],
            principal: "alice",
            source: "mcp",
        },
    ) as Record<string, JsonValue>;
    try {
        const failed = await bootstrap();
        assert.deepEqual(failed, { comment: ["Memory: unavailable"] });
        assert.ok(!JSON.stringify(failed).includes("PRIVATE_PATH"));

        phase = "stalled";
        const started = Date.now();
        const timeout = await bootstrap();
        assert.deepEqual(timeout, failed);
        assert.ok(Date.now() - started < 6_000,
            "optional Comment status cannot indefinitely block environ_info");

        phase = "recovered";
        const recovered = await bootstrap();
        assert.deepEqual(recovered, { comment: [`Memory: ${selectedMemory.directory}`] });
    } finally {
        uninstall();
        unbind();
        runtime.close();
        await rm(contextFile, { force: true });
    }
});
