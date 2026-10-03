import type {
    ContextRegistryPort,
    JsonValue,
    ToolCallContext,
    ToolDefinition,
} from "@portable-devshell/shared";
import { asInstanceName } from "@portable-devshell/shared";
import { ContextCleanupService } from "../../control/src/context/Cleanup.ts";
import { ContextEnvironmentService } from "../../control/src/context/Environment.ts";
import { ContextRegistry } from "../../control/src/context/Registry.ts";
import type { McpContextRegistryOptions } from "../../control/src/context/Model.ts";
import { ContextService } from "../../control/src/context/Service.ts";
import {
    McpEndpointWorker,
    type McpEndpointWorkerOptions,
} from "../src/endpoint/Endpoint.ts";
import {
    McpEndpointDispatch,
    type McpEndpointDispatchOptions,
} from "../src/endpoint/dispatch/Dispatch.ts";
import { McpHost, McpRuntimeState } from "../src/host/Host.ts";
import type { McpHostConfig } from "../src/host/Host.ts";
import type {
    McpEndpointWorkerPort,
    McpInstanceGateway,
} from "../src/endpoint/Port.ts";
import {
    ToolCallHookSequence,
    ToolCallPipeline,
    type ToolCallHookValue,
    type ToolCallTargetResolver,
} from "@portable-devshell/core";

function unexpectedGatewayOperation(name: string): never {
    throw new Error(`Unexpected test gateway operation: ${name}`);
}

function createFailClosedGateway(): McpInstanceGateway {
    return {
        appendMcpToolCalled: async () =>
            unexpectedGatewayOperation("appendMcpToolCalled"),
        assertReady() {},
        callTool: async () => unexpectedGatewayOperation("callTool"),
        async callToolOperation<T extends JsonValue>(
            instance: string,
            toolName: string,
            input: JsonValue,
            context: ToolCallContext,
            operation: (
                callId: string,
                input: JsonValue,
                finalValue: ToolCallHookValue,
            ) => Promise<T>,
        ): Promise<T> {
            return await operation("test-call", input, {
                kind: "call",
                toolName,
                payload: input,
                context: { ...context, instance: asInstanceName(instance) },
            });
        },
        environment: () => undefined,
        listInstances: async () => unexpectedGatewayOperation("listInstances"),
        listTools: () => [],
        readTodo: async () => unexpectedGatewayOperation("readTodo"),
        prepareWorkspace: async () =>
            unexpectedGatewayOperation("prepareWorkspace"),
        readAlerts: async () => unexpectedGatewayOperation("readAlerts"),
        releaseAlerts: async () => unexpectedGatewayOperation("releaseAlerts"),
        connectInstance: async () =>
            unexpectedGatewayOperation("connectInstance"),
        releaseInstanceReference: async () =>
            unexpectedGatewayOperation("releaseInstanceReference"),
        statusInstance: async () =>
            unexpectedGatewayOperation("statusInstance"),
        stopInstance: async () => unexpectedGatewayOperation("stopInstance"),
        touchAlerts: async () => unexpectedGatewayOperation("touchAlerts"),
        touchTemporaryDirectory: async () =>
            unexpectedGatewayOperation("touchTemporaryDirectory"),
        writeTodo: async () => unexpectedGatewayOperation("writeTodo"),
    };
}

export function createTestWorkerGateway(
    resolveTarget: ToolCallTargetResolver,
    listTools: () => ToolDefinition[],
): McpInstanceGateway {
    const pipeline = new ToolCallPipeline({
        hooks: () => ({ release() {}, sequence: new ToolCallHookSequence({}) }),
        resolveTarget,
    });
    return {
        ...createFailClosedGateway(),
        assertReady() {},
        callTool: (...args) => pipeline.call(...args),
        callToolOperation: (...args) => pipeline.callOperation(...args),
        listTools: () => listTools(),
    };
}

export function createTestCallOperationGateway(): McpInstanceGateway {
    return {
        ...createFailClosedGateway(),
        async callToolOperation<T extends JsonValue>(
            instance: string,
            toolName: string,
            input: JsonValue,
            context: ToolCallContext,
            operation: (
                callId: string,
                input: JsonValue,
                finalValue: ToolCallHookValue,
            ) => Promise<T>,
        ): Promise<T> {
            return await operation("test-call", input, {
                kind: "call",
                toolName,
                payload: input,
                context: { ...context, instance: asInstanceName(instance) },
            });
        },
    };
}

export function createTestContextRuntime(
    options: {
        contextRegistry?: ContextRegistryPort;
        registryOptions?: McpContextRegistryOptions;
        instanceName?: string;
        gateway?: McpInstanceGateway | (() => McpInstanceGateway | undefined);
        worker?: McpEndpointWorkerPort;
    } = {},
) {
    const registry =
        options.contextRegistry ?? new ContextRegistry(options.registryOptions);
    const gateway = (_instance: string): McpInstanceGateway | undefined =>
        typeof options.gateway === "function"
            ? options.gateway()
            : options.gateway;
    const worker = (instance: string): McpEndpointWorkerPort | undefined =>
        instance === options.instanceName ? options.worker : undefined;
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway,
        releaseLocalAlerts: async (instance, workspace) =>
            await worker(instance)?.releaseAlerts?.(workspace),
    });
    const environment = new ContextEnvironmentService({
        cleanup,
        contextRegistry: registry,
        gateway,
        worker,
    });
    const service = new ContextService({
        cleanup,
        environment,
        gateway,
        registry,
        worker,
    });
    return { cleanup, environment, registry, service };
}

export function createTestContextEnvironment(
    options: {
        contextRegistry?: ContextRegistryPort;
        registryOptions?: McpContextRegistryOptions;
        instanceName?: string;
        gateway?: McpInstanceGateway | (() => McpInstanceGateway | undefined);
        worker?: McpEndpointWorkerPort;
    } = {},
) {
    return createTestContextRuntime(options).environment;
}

export function createTestEndpointDispatch(
    options: Omit<
        McpEndpointDispatchOptions,
        "cleanup" | "contextRegistry" | "environmentService"
    > & { contextRegistry?: ContextRegistryPort },
) {
    const runtime = createTestContextRuntime({
        contextRegistry: options.contextRegistry,
        instanceName: options.instanceName,
        gateway: options.gateway,
        worker: options.worker,
    });
    return new McpEndpointDispatch({
        ...options,
        cleanup: runtime.cleanup,
        contextRegistry: runtime.registry,
        environmentService: runtime.environment,
    });
}

export function createTestMcpRuntimeState(
    options: {
        contextFile?: string;
        storageDir?: string;
        workspaceAppLeaseFile?: string;
    } = {},
) {
    const registry = new ContextRegistry({
        ...(options.contextFile === undefined
            ? {}
            : { filePath: options.contextFile }),
    });
    const stateRef: { current?: McpRuntimeState } = {};
    const requireState = (): McpRuntimeState => {
        if (stateRef.current === undefined) {
            throw new Error("Test MCP runtime state is not initialized.");
        }
        return stateRef.current;
    };
    const gateway = (instance: string): McpInstanceGateway | undefined =>
        requireState().gateways.get(instance);
    const worker = (instance: string): McpEndpointWorkerPort | undefined =>
        requireState().workers.get(instance);
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        gateway,
        releaseLocalAlerts: async (instance, workspace) =>
            await worker(instance)?.releaseAlerts?.(workspace),
    });
    const environment = new ContextEnvironmentService({
        cleanup,
        contextRegistry: registry,
        gateway,
        worker,
    });
    const contexts = new ContextService({
        cleanup,
        environment,
        gateway,
        registry,
        worker,
    });
    const state: McpRuntimeState = new McpRuntimeState({
        contexts,
        storageDir: options.storageDir,
        workspaceAppLeaseFile: options.workspaceAppLeaseFile,
    });
    stateRef.current = state;
    return state;
}

export class TestMcpHost extends McpHost {
    readonly contexts: ContextService;

    constructor(
        config: McpHostConfig & { contextFile?: string },
        state = createTestMcpRuntimeState({
            contextFile: config.contextFile,
            storageDir: config.storageDir,
            workspaceAppLeaseFile: config.workspaceAppLeaseFile,
        }),
    ) {
        super(config, state);
        this.contexts = state.contexts as ContextService;
    }

    override async start(): Promise<void> {
        await this.contexts.initialize();
        await super.start();
        await this.contexts.reconcile();
    }
}

export class TestMcpEndpointWorker extends McpEndpointWorker {
    constructor(
        options: Omit<
            McpEndpointWorkerOptions,
            "cleanup" | "contextRegistry" | "environmentService"
        > & {
            contextRegistry?: ContextRegistryPort;
        },
    ) {
        const runtime = createTestContextRuntime({
            contextRegistry: options.contextRegistry,
            instanceName: options.instanceName,
            gateway: options.gateway,
            worker: options.worker,
        });
        super({
            ...options,
            contextRegistry: runtime.registry,
            cleanup: runtime.cleanup,
            environmentService: runtime.environment,
        });
    }
}
