import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    asInstanceName,
    type EnvironmentTransport,
    type InstanceProcessEnvelope,
    type InstanceRuntimeTransport,
    type JsonValue,
    type ProcessTransport,
    type ToolCallExecutor,
    type ToolCallHooks,
} from "@portable-devshell/shared";

import type { ContextApi } from "../../../src/context/Api.ts";
import { createContextRuntime } from "../../../src/context/index.ts";
import {
    contextToolDefinitions,
    installContextTools,
} from "../../../src/context/Public.ts";
import { createToolCallRegistry } from "../../../src/toolcall/index.ts";

function createHooks() {
    const executes = new Map<string, ToolCallExecutor>();
    const hooks: ToolCallHooks = {
        registerContributor: () => () => undefined,
        registerExecute: (name, execute) => {
            executes.set(name, execute);
            return () => executes.delete(name);
        },
        registerReview: () => () => undefined,
    };
    return { executes, hooks };
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

test("Context owns environ tool definitions with structured environment output", () => {
    const definitions = contextToolDefinitions();
    assert.deepEqual(
        definitions.map((definition) => definition.name),
        ["environ_info", "environ_remote"],
    );
    const info = definitions[0]!;
    const output = info.outputSchema as Record<string, JsonValue>;
    const properties = output.properties as Record<string, JsonValue>;
    const platform = properties.platform as Record<string, JsonValue>;
    assert.equal(platform.additionalProperties, false);
    assert.deepEqual(platform.required, ["arch", "os"]);
});

test("Context registers definitions and executes environ_info through ToolCall hook", async () => {
    const { executes, hooks } = createHooks();
    const registry = createToolCallRegistry();
    const unbind = registry.bind(hooks);

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
        const execute = executes.get("environ_info");
        assert.ok(execute);
        const result = await execute(
            "call-1",
            { workspace: "/repo" },
            {
                context: {
                    contextMode: "explicit",
                    externalBindings: [{ kind: "session", value: "s-1" }],
                    instance: asInstanceName("local"),
                    principal: "alice",
                    source: "mcp",
                },
                kind: "call",
                payload: { workspace: "/repo" },
                toolName: "environ_info",
            },
        );
        const record = result as Record<string, JsonValue>;
        assert.equal(externalPrincipal, "alice");
        assert.ok(preparedCtxId !== undefined && preparedCtxId.length > 0);
        assert.equal(record.ctxId, preparedCtxId);
        assert.equal(record.workspace, "/repo");
        assert.equal(record.skillsDirectory, "/skills");
    } finally {
        uninstall();
        unbind();
        runtime.close();
        await rm(contextFile, { force: true });
    }
    assert.equal(registry.get("local", "environ_info"), undefined);
});
