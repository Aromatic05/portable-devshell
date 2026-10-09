import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    ContextApi,
    ContextRuntime,
} from "../../control/src/context/Api.ts";
import { createContextRuntime } from "../../control/src/context/index.ts";
import { installContextTools } from "../../control/src/context/tool/Runtime.ts";
import type {
    ContextTransport,
    Endpoint,
    EnvironmentTransport,
    InstanceRuntimeTransport,
    ProcessTransport,
    ToolCallApi,
    ToolCallTargetResolver,
    ToolDefinition,
    ToolCallTarget,
} from "@portable-devshell/shared";
import { createToolCallRuntime } from "@portable-devshell/shared";
import type { ContextChangeEvent } from "@portable-devshell/shared";
import type { EventStreamPort } from "../../shared/src/client/Stream.ts";

import {
    McpEndpointDispatch,
    type McpEndpointDispatchOptions,
} from "../src/endpoint/dispatch/Dispatch.ts";
import {
    McpEndpoint,
    type McpEndpointOptions,
} from "../src/endpoint/Endpoint.ts";
import { McpHost } from "../src/server/Host.ts";
import { McpRuntimeState } from "../src/Runtime.ts";
import { HttpHost } from "../src/testing/Http.ts";
import type {
    McpHostConfig,
    McpHostInstanceConfig,
} from "../src/server/Host.ts";
import {
    createTestWorkerToolRuntime,
    createTestWorkerInstance,
    type TestWorkerInstanceFields,
} from "./support/WorkerInstance.ts";
import {
    TestToolSource,
    type TestToolRegistration,
} from "./support/ToolSource.ts";

export interface TestContextRuntime extends Omit<ContextRuntime, "close">, ContextApi {
    close(): Promise<void>;
}

export interface TestMcpRuntimeState {
    readonly contexts: TestContextRuntime;
    readonly contextTransport: ContextTransport;
    readonly state: McpRuntimeState;
    readonly toolCallRuntime: ReturnType<typeof createToolCallRuntime>;
    readonly toolSource: TestToolSource;
    readonly closeContextTools: () => void;
    readonly oauthResource: McpRuntimeState["oauthResource"];
}

export interface TestMcpRuntimeOptions {
    contextFile?: string;
    endpoint?: Endpoint;
    tools?: ToolCallApi;
    resolveTarget?: ToolCallTargetResolver;
    configureToolCalls?: (
        runtime: ReturnType<typeof createToolCallRuntime>,
    ) => void;
    toolSource?: TestToolSource;
}

export function createTestContextRuntime(
    options: Pick<TestMcpRuntimeOptions, "contextFile"> = {},
): TestContextRuntime {
    const contextFile = options.contextFile ?? join(
        tmpdir(),
        `portable-devshell-test-context-${randomUUID()}.jsonl`,
    );
    const removeContextFile = options.contextFile === undefined;
    const runtime = createContextRuntime({
        contextFile,
        environment: () => testEnvironment,
        leaseInstance: () => ({ release() {} }),
        process: () => testProcess,
        runtime: () => testInstanceRuntime,
    });
    const closeRuntime = runtime.close.bind(runtime);
    return Object.assign(runtime, {
        cleanup: runtime.api.cleanup,
        environment: runtime.api.environment,
        registry: runtime.api.registry,
        disable: runtime.api.disable.bind(runtime.api),
        detachInstance: runtime.api.detachInstance.bind(runtime.api),
        reconcileInstance: runtime.api.reconcileInstance.bind(runtime.api),
        renew: runtime.api.renew.bind(runtime.api),
        resolve: runtime.api.resolve.bind(runtime.api),
        async close() {
            closeRuntime();
            if (removeContextFile) await rm(contextFile, { force: true });
        },
    });
}

export function createTestContextEnvironment(
    options: Pick<TestMcpRuntimeOptions, "contextFile"> = {},
) {
    return createTestContextRuntime(options).environment;
}

export function createTestEndpointDispatch(
    options: McpEndpointDispatchOptions,
) {
    return new McpEndpointDispatch(options);
}

export function createTestToolCallApi(
    resolveTarget?: ToolCallTargetResolver,
): ToolCallApi {
    return createToolCallRuntime({
        resolveTarget: resolveTarget ?? (() => ({
            async dispatch() {
                throw new Error("Test MCP tool target is not configured.");
            },
        })),
    }).api;
}

export function createTestInstance(options: TestWorkerInstanceFields) {
    const worker = createTestWorkerInstance(options);
    const mcpWorker = Object.assign(worker, {
        listTools: () => runtime.execution.listTools(),
        appendMcpSessionClosed: async (sessionId: string) => {
            await worker.appendControlEvent("mcp.sessionClosed", { sessionId });
        },
        appendMcpSessionOpened: async (sessionId: string) => {
            await worker.appendControlEvent("mcp.sessionOpened", { sessionId });
        },
        appendMcpToolCalled: async (
            toolName: string,
            context: { ctxId?: string; requestId?: string },
        ) => {
            await worker.appendControlEvent("mcp.toolCalled", {
                ...context,
                source: "mcp",
                toolName,
            });
        },
    });
    const runtime = createTestWorkerToolRuntime({
        homeDirectory: options.homeDirectory,
        instanceName: options.name,
        worker: mcpWorker,
    });
    return {
        worker: mcpWorker,
        runtime,
        async start() {
            await worker.start();
            await runtime.execution.refreshTools();
        },
        async close() {
            await runtime.execution.close();
            await runtime.audit.close();
            await worker.stop();
            await worker.close();
        },
        target: () => runtime.execution.target(),
        listTools: () => runtime.execution.listTools(),
        readToolCalls: (query?: import("@portable-devshell/shared").ToolCallQuery) =>
            runtime.execution.readToolCalls(query),
    };
}

export function createTestMcpRuntimeState(
    options: TestMcpRuntimeOptions & {
        storageDir?: string;
        mcpAppLeaseFile?: string;
    } = {},
): TestMcpRuntimeState {
    const contexts = createTestContextRuntime({
        contextFile: options.contextFile,
    });
    const context = createContextTransport(contexts);
    const toolCallRuntime = createToolCallRuntime({
        resolveTarget: options.resolveTarget ?? (() => ({
            async dispatch() {
                throw new Error("Test MCP tool target is not configured.");
            },
        })),
    });
    const toolSource = options.toolSource ?? new TestToolSource();
    const closeContextTools = installContextTools(
        contexts,
        toolSource.registration(toolCallRuntime.hooks),
        {
            environment: () => testEnvironment,
            leaseInstance: () => ({ release() {} }),
            process: () => testProcess,
        },
    );
    options.configureToolCalls?.(toolCallRuntime);
    const state = new McpRuntimeState({
        context,
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        tools: options.tools ?? toolCallRuntime.api,
        storageDir: options.storageDir,
        mcpAppLeaseFile: options.mcpAppLeaseFile,
    });
    return {
        contexts,
        contextTransport: context,
        state,
        toolCallRuntime,
        toolSource,
        closeContextTools,
        oauthResource: state.oauthResource.bind(state),
    };
}

export interface TestMcpHostConfig
    extends Omit<McpHostConfig, "toolSource" | "instances"> {
    instances: readonly TestMcpHostInstanceConfig[];
    contextFile?: string;
    tools?: ToolCallApi;
    resolveTarget?: ToolCallTargetResolver;
    configureToolCalls?: TestMcpRuntimeOptions["configureToolCalls"];
    toolSource?: TestToolSource;
}

export interface TestMcpHostInstanceConfig extends McpHostInstanceConfig {
    worker?: {
        listTools?: () => readonly ToolDefinition[];
        target?: () => ToolCallTarget;
    };
}

export class TestMcpHost extends McpHost {
    readonly contexts: TestContextRuntime;
    readonly #testRuntime: TestMcpRuntimeState;
    readonly #toolRegistrations = new Map<
        string,
        TestToolRegistration
    >();
    readonly #listWorkerTools = new Map<string, () => readonly ToolDefinition[]>();

    constructor(config: TestMcpHostConfig, runtime?: TestMcpRuntimeState) {
        const {
            contextFile,
            tools,
            resolveTarget,
            configureToolCalls,
            toolSource: configuredToolSource,
            ...hostConfig
        } = config;
        const toolSource =
            configuredToolSource ?? runtime?.toolSource ?? new TestToolSource();
        const targetResolver = resolveTarget ?? ((instance: string) => {
            const target = config.instances
                .find((entry) => entry.name === instance)
                ?.worker?.target?.();
            if (target !== undefined) return target;
            throw new Error(`Test MCP target is not configured for ${instance}.`);
        });
        const testRuntime = runtime ?? createTestMcpRuntimeState({
            contextFile,
            tools,
            resolveTarget: targetResolver,
            configureToolCalls,
            toolSource,
            storageDir: hostConfig.storageDir,
            mcpAppLeaseFile: hostConfig.mcpAppLeaseFile,
        });
        const toolRegistrations: [
            string,
            TestToolRegistration,
        ][] = [];
        const workerToolListings: [
            string,
            () => readonly ToolDefinition[],
        ][] = [];
        for (const instance of config.instances) {
            const listTools = instance.worker?.listTools;
            if (listTools !== undefined) {
                toolRegistrations.push(
                    [instance.name, toolSource.register(instance.name, listTools())],
                );
                workerToolListings.push([instance.name, listTools]);
            }
        }
        super({
            ...hostConfig,
            instances: config.instances.map(({ worker: _worker, ...instance }) => instance),
            toolSource,
        }, testRuntime.state, {
            acquire: (address) => new HttpHost(address),
        });
        for (const [name, registration] of toolRegistrations)
            this.#toolRegistrations.set(name, registration);
        for (const [name, listTools] of workerToolListings)
            this.#listWorkerTools.set(name, listTools);
        this.contexts = testRuntime.contexts;
        this.#testRuntime = testRuntime;
    }

    override async start(): Promise<void> {
        await this.contexts.initialize();
        for (const [instance, listTools] of this.#listWorkerTools) {
            this.#toolRegistrations.get(instance)?.replace(listTools());
        }
        await super.start();
        await this.contexts.reconcile();
    }

    override async stop(): Promise<void> {
        const failures: unknown[] = [];
        await super.stop().catch((error) => failures.push(error));
        this.#testRuntime.closeContextTools();
        this.#testRuntime.toolCallRuntime.close();
        for (const registration of this.#toolRegistrations.values())
            registration.dispose();
        await this.contexts.close().catch((error) => failures.push(error));
        if (failures.length > 0)
            throw new AggregateError(failures, "Test MCP host shutdown failed.");
    }

    replaceTestTools(
        instance: string,
        definitions: readonly import("@portable-devshell/shared").ToolDefinition[],
    ): void {
        const registration = this.#toolRegistrations.get(instance);
        if (registration === undefined)
            throw new Error(`No test tool registration for ${instance}.`);
        registration.replace(definitions);
    }
}

export function createTestMcpEndpoint(
    options: Omit<McpEndpointOptions, "context" | "tools" | "toolSource"> &
        Partial<Pick<McpEndpointOptions, "context" | "tools" | "toolSource">>,
): McpEndpoint {
    return new McpEndpoint({
        ...options,
        context: options.context ?? {
            async resolve() {
                throw new Error("Test MCP Context is not configured.");
            },
        },
        toolSource: options.toolSource ?? new TestToolSource(),
        tools: options.tools ?? createTestToolCallApi(),
    });
}

function createContextTransport(contexts: TestContextRuntime): ContextTransport {
    return {
        snapshot: async () => await contexts.registry.snapshot(),
        subscribe: async (fromRevision) => createContextChangeStream(contexts, fromRevision),
        disable: async (ctxId, signal) => {
            signal?.throwIfAborted();
            return await contexts.disable(ctxId);
        },
        list: async (query, signal) => {
            signal?.throwIfAborted();
            return await contexts.registry.list(query);
        },
        renew: async (ctxId, signal) => {
            signal?.throwIfAborted();
            return await contexts.renew(ctxId);
        },
        resolve: async (input, signal) => {
            signal?.throwIfAborted();
            return await contexts.resolve(input);
        },
        referenceInstance: async (ctxId, instance, signal) => {
            signal?.throwIfAborted();
            return await contexts.registry.referenceInstance(ctxId, instance);
        },
        validateForInstance: async (ctxId, instance, signal) => {
            signal?.throwIfAborted();
            return await contexts.registry.validateForInstance(ctxId, instance);
        },
        detachInstance: async (instance, signal) => {
            signal?.throwIfAborted();
            return await contexts.detachInstance(instance);
        },
        reconcileInstance: async (instance, signal) => {
            signal?.throwIfAborted();
            await contexts.reconcileInstance(instance);
        },
    };
}

function createContextChangeStream(
    contexts: TestContextRuntime,
    fromRevision: number,
): EventStreamPort<ContextChangeEvent> {
    const initial = contexts.registry.changes.readSince(fromRevision);
    const queue: Array<
        | { kind: "event"; event: ContextChangeEvent }
        | { details?: never; gap: { fromSeq: number; lastSeq: number; nextSeq: number }; kind: "gap" }
    > = initial.kind === "gap"
        ? [{
              kind: "gap",
              gap: {
                  fromSeq: fromRevision,
                  lastSeq: initial.latestRevision,
                  nextSeq: initial.oldestAvailableRevision,
              },
          }]
        : initial.changes.map((change) => ({
              kind: "event" as const,
              event: { ctxIds: [...change.ctxIds], revision: change.revision },
          }));
    const waiters: Array<(message: (typeof queue)[number] | { kind: "closed" }) => void> = [];
    let closed = false;
    const unsubscribe = contexts.registry.changes.onChange((change) => {
        const message = {
            kind: "event" as const,
            event: { ctxIds: [...change.ctxIds], revision: change.revision },
        };
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(message);
        else queue.push(message);
    });
    return {
        close() {
            if (closed) return;
            closed = true;
            unsubscribe();
            for (const waiter of waiters.splice(0)) waiter({ kind: "closed" });
        },
        async next() {
            const message = queue.shift() ?? (closed
                ? { kind: "closed" as const }
                : await new Promise<(typeof queue)[number] | { kind: "closed" }>((resolve) => waiters.push(resolve)));
            return message.kind === "event"
                ? message
                : message.kind === "gap"
                  ? message
                  : message;
        },
    };
}

const testEnvironment: EnvironmentTransport = {
    async prepareExtensionResource() {
        throw new Error("Test MCP extension resources are not configured.");
    },
    async prepareWorkspace(workspace) {
        return {
            projectMemoryAgentFile: `${workspace}/AGENTS.md`,
            projectMemoryDirectory: workspace,
            projectMemoryPresent: false,
            temporaryDirectory: `${workspace}/tmp`,
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

const testInstanceRuntime: InstanceRuntimeTransport = {
    async acquireReference() {
        return {};
    },
    async appendEvent() {},
    async readEvents() {
        return { events: [], gap: false, latestSeq: 0 };
    },
    async releaseReference() {},
    async subscribeEvents() {
        throw new Error("Test MCP instance events are not configured.");
    },
};

const testProcess: ProcessTransport = {
    async readLogs() {
        return [];
    },
    async refresh() {
        return { snapshot: { ready: true } } as never;
    },
    async snapshot() {
        return {
            lastSeq: 0,
            snapshot: { ready: true },
            worker: {
                capabilities: { cancel: true, streaming: true, tools: true },
                platform: {
                    arch: "x86_64",
                    distribution: { id: "test", name: "Test" },
                    os: process.platform,
                    packageManager: "test",
                    shell: { executable: "/bin/sh", kind: "sh", version: "test" },
                },
                protocolVersion: "1",
                version: "test",
            },
        } as never;
    },
    async start() {
        throw new Error("Test MCP processes are not configured.");
    },
    async stop() {
        return { ready: false } as never;
    },
    async subscribe() {
        throw new Error("Test MCP process events are not configured.");
    },
};
