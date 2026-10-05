import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    ContextApi,
    ContextRuntime,
} from "@portable-devshell/core/context";
import { createContextRuntime } from "@portable-devshell/core/context";
import {
    InstanceRegistry,
    type WorkerInstance,
} from "@portable-devshell/core/instance";
import type { ToolCallApi } from "@portable-devshell/core/toolcall";
import { createToolCallRuntime } from "@portable-devshell/core/toolcall";
import { installContextTools } from "@portable-devshell/core/context";
import type {
    ContextTransport,
} from "@portable-devshell/shared";
import type { ContextChangeEvent } from "@portable-devshell/shared";
import type { EventStreamPort } from "../../shared/src/client/Stream.ts";

import {
    McpEndpointDispatch,
    type McpEndpointDispatchOptions,
} from "../src/endpoint/dispatch/Dispatch.ts";
import { McpHost, McpRuntimeState } from "../src/host/Host.ts";
import type {
    McpHostConfig,
    McpHostInstanceConfig,
} from "../src/host/Host.ts";
import type { McpEndpointWorkerOptions } from "../src/endpoint/Endpoint.ts";
import { McpEndpointWorker } from "../src/endpoint/Endpoint.ts";
import type { ToolCallTargetResolver } from "@portable-devshell/core/toolcall";
import {
    createTestWorkerToolRuntime,
    createTestWorkerInstance,
    type TestWorkerInstanceFields,
} from "../../core/test/support/WorkerInstance.ts";
import { mcpTools } from "@portable-devshell/mcp/tool";

export interface TestContextRuntime extends Omit<ContextRuntime, "close">, ContextApi {
    close(): Promise<void>;
}

export interface TestMcpRuntimeState {
    readonly contexts: TestContextRuntime;
    readonly contextTransport: ContextTransport;
    readonly state: McpRuntimeState;
    readonly toolCallRuntime: ReturnType<typeof createToolCallRuntime>;
    readonly closeContextTools: () => void;
    readonly oauthResource: McpRuntimeState["oauthResource"];
}

export interface TestMcpRuntimeOptions {
    contextFile?: string;
    instances?: InstanceRegistry;
    tools?: ToolCallApi;
    resolveTarget?: ToolCallTargetResolver;
    configureToolCalls?: (
        runtime: ReturnType<typeof createToolCallRuntime>,
    ) => void;
}

export function createTestContextRuntime(
    options: Pick<TestMcpRuntimeOptions, "contextFile" | "instances"> = {},
): TestContextRuntime {
    const contextFile = options.contextFile ?? join(
        tmpdir(),
        `portable-devshell-test-context-${randomUUID()}.jsonl`,
    );
    const removeContextFile = options.contextFile === undefined;
    const runtime = createContextRuntime({
        contextFile,
        instances: options.instances ?? emptyInstances(),
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
    options: Pick<TestMcpRuntimeOptions, "contextFile" | "instances"> = {},
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
    const registration = mcpTools.register(options.name, []);
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
            registration.replace(await runtime.execution.refreshTools());
        },
        async close() {
            registration.dispose();
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
        instances: options.instances,
    });
    const context = createContextTransport(contexts);
    const toolCallRuntime = createToolCallRuntime({
        resolveTarget: options.resolveTarget ?? (() => ({
            async dispatch() {
                throw new Error("Test MCP tool target is not configured.");
            },
        })),
    });
    const closeContextTools = installContextTools(
        contexts,
        toolCallRuntime.hooks,
        { instances: options.instances ?? emptyInstances() },
    );
    options.configureToolCalls?.(toolCallRuntime);
    const state = new McpRuntimeState({
        context,
        tools: options.tools ?? toolCallRuntime.api,
        storageDir: options.storageDir,
        mcpAppLeaseFile: options.mcpAppLeaseFile,
    });
    return {
        contexts,
        contextTransport: context,
        state,
        toolCallRuntime,
        closeContextTools,
        oauthResource: state.oauthResource.bind(state),
    };
}

export interface TestMcpHostConfig extends McpHostConfig {
    contextFile?: string;
    tools?: ToolCallApi;
    resolveTarget?: ToolCallTargetResolver;
    configureToolCalls?: TestMcpRuntimeOptions["configureToolCalls"];
}

export class TestMcpHost extends McpHost {
    readonly contexts: TestContextRuntime;
    readonly #testRuntime: TestMcpRuntimeState;
    readonly #toolRegistrations = new Map<
        string,
        ReturnType<typeof mcpTools.register>
    >();

    constructor(config: TestMcpHostConfig, runtime?: TestMcpRuntimeState) {
        const {
            contextFile,
            tools,
            resolveTarget,
            configureToolCalls,
            ...hostConfig
        } = config;
        const testRuntime = runtime ?? createTestMcpRuntimeState({
            contextFile,
            instances: instancesForHost(hostConfig.instances),
            tools,
            resolveTarget,
            configureToolCalls,
            storageDir: hostConfig.storageDir,
            mcpAppLeaseFile: hostConfig.mcpAppLeaseFile,
        });
        const toolRegistrations: [
            string,
            ReturnType<typeof mcpTools.register>,
        ][] = [];
        for (const instance of config.instances) {
            const listTools = (
                instance.worker as McpHostInstanceConfig["worker"] & {
                    listTools?: () => readonly import("@portable-devshell/shared").ToolDefinition[];
                }
            ).listTools;
            if (listTools !== undefined)
                toolRegistrations.push(
                    [instance.name, mcpTools.register(instance.name, listTools())],
                );
        }
        super(hostConfig, testRuntime.state);
        for (const [name, registration] of toolRegistrations)
            this.#toolRegistrations.set(name, registration);
        this.contexts = testRuntime.contexts;
        this.#testRuntime = testRuntime;
    }

    override async start(): Promise<void> {
        await this.contexts.initialize();
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

export class TestMcpEndpointWorker extends McpEndpointWorker {
    constructor(
        options: Omit<McpEndpointWorkerOptions, "context" | "tools"> & {
            context?: McpEndpointWorkerOptions["context"];
            tools?: McpEndpointWorkerOptions["tools"];
        },
    ) {
        const contexts = createTestContextRuntime();
        const contextTransport = createContextTransport(contexts);
        super({
            ...options,
            context: options.context ?? contextTransport,
            tools: options.tools ?? createTestToolCallApi(),
        });
    }
}

function instancesForHost(instances: readonly McpHostInstanceConfig[]): InstanceRegistry {
    return new InstanceRegistry(instances.map((config) => new Instance({
        enabled: true,
        mcpContextMode: config.contextMode,
        mcpEnabled: true,
        mcpPath: config.path ?? `/${config.name}/mcp`,
        modelExtensions: [],
        name: config.name,
        provider: "local",
        worker: config.worker as unknown as WorkerInstance,
    })));
}

function emptyInstances(): InstanceRegistry {
    return new InstanceRegistry([]);
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
