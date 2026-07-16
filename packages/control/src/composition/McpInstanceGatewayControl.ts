import type {
    McpInstanceGateway,
    McpSshInstanceCreateInput
} from "@portable-devshell/mcp";
import {
    createError,
    errorCodes,
    type JsonValue,
    type ToolCallContext,
    type ToolDefinition
} from "@portable-devshell/shared";

import type { InstanceCreateCoordinator } from "../control/instance/create/InstanceCreateCoordinator.js";
import type { ControlConfig } from "@portable-devshell/shared";
import type { InstanceRegistry } from "../control/instance/registry/InstanceRegistry.js";

export interface McpInstanceGatewayControlOptions {
    createService: InstanceCreateCoordinator;
    getConfig: () => ControlConfig;
    instanceRegistry: InstanceRegistry;
}

export class McpInstanceGatewayControl implements McpInstanceGateway {
    readonly #createService: InstanceCreateCoordinator;
    readonly #getConfig: () => ControlConfig;
    readonly #instanceRegistry: InstanceRegistry;

    constructor(options: McpInstanceGatewayControlOptions) {
        this.#createService = options.createService;
        this.#getConfig = options.getConfig;
        this.#instanceRegistry = options.instanceRegistry;
    }

    assertReady(instance: string): void {
        const descriptor = this.#requireDescriptor(instance);
        if (!descriptor.worker.snapshot().ready) {
            throw createError({
                code: errorCodes.coreInstanceNotReady,
                details: { instance },
                message: `Instance ${instance} is not ready.`,
                retryable: false
            });
        }
    }

    async callTool(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        return await descriptor.worker.callTool(toolName, input, context, signal);
    }

    async closeToolSession(sessionId: string): Promise<void> {
        await Promise.all(
            this.#instanceRegistry.list().map(async (descriptor) => {
                await descriptor.worker.releaseToolSession(sessionId);
            })
        );
    }

    async createSshInstance(sourceInstance: string, input: McpSshInstanceCreateInput): Promise<JsonValue> {
        return (await this.#createService.createSshInstanceFromMcp(sourceInstance, input)) as unknown as JsonValue;
    }

    async listInstances(): Promise<JsonValue> {
        const configByName = new Map(this.#getConfig().instances.map((instance) => [instance.name, instance] as const));
        return this.#instanceRegistry.list().map((descriptor) => {
            const config = configByName.get(descriptor.name);
            return {
                enabled: descriptor.enabled,
                mcpEnabled: descriptor.mcpEnabled,
                name: descriptor.name,
                provider: config?.provider,
                snapshot: withTodoSummary(descriptor.worker.snapshot(), descriptor.todo.summary())
            };
        }) as unknown as JsonValue;
    }

    async readTodo(instance: string): Promise<JsonValue> {
        return (await this.#requireDescriptor(instance).todo.read()) as unknown as JsonValue;
    }

    listTools(instance: string): ToolDefinition[] {
        return this.#requireDescriptor(instance).worker.listTools();
    }

    async startInstance(instance: string): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        if (!descriptor.enabled) {
            throw createError({
                code: errorCodes.instanceConflict,
                details: { instance, operation: "start" },
                message: `Instance ${instance} is disabled.`,
                retryable: false
            });
        }
        const snapshot = await descriptor.worker.start();
        this.#instanceRegistry.markOwned(instance);
        return snapshot as unknown as JsonValue;
    }

    async statusInstance(instance: string): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        const config = this.#getConfig().instances.find((entry) => entry.name === instance);
        return {
            enabled: descriptor.enabled,
            mcpEnabled: descriptor.mcpEnabled,
            name: descriptor.name,
            provider: config?.provider,
            snapshot: withTodoSummary(descriptor.worker.snapshot(), descriptor.todo.summary())
        } as unknown as JsonValue;
    }

    async stopInstance(instance: string): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        const snapshot = await descriptor.worker.stop();
        this.#instanceRegistry.clearOwned(instance);
        return snapshot as unknown as JsonValue;
    }

    async writeTodo(instance: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        return (await descriptor.todo.write(
            input as unknown as import("@portable-devshell/shared").TodoWriteInput,
            requireCtxId(context)
        )) as unknown as JsonValue;
    }

    #requireDescriptor(instance: string) {
        const descriptor = this.#instanceRegistry.get(instance);
        if (descriptor !== undefined) {
            return descriptor;
        }
        throw createError({
            code: errorCodes.instanceMissing,
            details: { instance },
            message: `Instance ${instance} was not found.`,
            retryable: false
        });
    }
}

function withTodoSummary<T extends object>(snapshot: T, activeTodo: import("@portable-devshell/shared").ActiveTodoSummary | undefined): T & { activeTodo?: import("@portable-devshell/shared").ActiveTodoSummary } {
    return {
        ...snapshot,
        ...(activeTodo === undefined ? {} : { activeTodo })
    };
}

function requireCtxId(context: ToolCallContext): string {
    if (context.ctxId !== undefined && context.ctxId.length > 0) {
        return context.ctxId;
    }
    throw createError({
        code: errorCodes.mcpContextInvalid,
        message: "todo_write requires a validated ctxId.",
        retryable: false
    });
}
