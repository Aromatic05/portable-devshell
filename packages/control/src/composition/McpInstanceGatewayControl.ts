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

    async appendMcpToolCalled(instance: string, toolName: string, context: { requestId?: string; ctxId?: string }): Promise<void> {
        await this.#requireDescriptor(instance).worker.appendMcpToolCalled(toolName, context);
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

    async auditToolCall<T extends JsonValue>(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string) => Promise<T>,
        signal?: AbortSignal
    ): Promise<T> {
        return await this.#requireDescriptor(instance).worker.auditToolCall(
            toolName,
            input,
            context,
            operation,
            signal
        );
    }

    async callTool(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (result: JsonValue, callId: string) => Promise<JsonValue>
    ): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        return await descriptor.worker.callTool(toolName, input, context, signal, transformResult);
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

    environment(instance: string) {
        return this.#requireDescriptor(instance).worker.handshake;
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
                snapshot: withTodoSummaries(descriptor.worker.snapshot(), descriptor.todo.summaries())
            };
        }) as unknown as JsonValue;
    }

    async createWait(instance: string, input: import("@portable-devshell/shared").WaitCreateInput) {
        return await this.#requireWait(instance).create(input);
    }

    async cancelWait(instance: string, waitId: string) {
        return await this.#requireWait(instance).cancel(waitId);
    }

    async detachWait(instance: string, waitId: string) {
        return await this.#requireWait(instance).detach(waitId);
    }

    async consumeWait(instance: string, waitId: string) {
        return await this.#requireWait(instance).consume(waitId);
    }

    async resolveWait(instance: string, waitId: string, result?: JsonValue) {
        return await this.#requireWait(instance).resolve(waitId, result);
    }

    async waitForWait(instance: string, waitId: string) {
        return await this.#requireWait(instance).waitForResolution(waitId);
    }

    async listWaits(instance: string) {
        return await this.#requireWait(instance).list();
    }

    async listApprovals(instance: string) {
        return await this.#requireDescriptor(instance).worker.listApprovals();
    }

    async readToolCalls(instance: string, ctxId: string, limit: number) {
        return await this.#requireDescriptor(instance).worker.readToolCalls({ ctxId, limit });
    }

    async readWorkspaceEvents(instance: string, fromSeq: number) {
        const result = this.#requireDescriptor(instance).worker.subscribe(fromSeq);
        return result.kind === "gap"
            ? { events: [], gap: true, lastSeq: result.lastSeq }
            : { events: result.events, gap: false, lastSeq: result.lastSeq };
    }

    async controlTodo(
        instance: string,
        taskId: string,
        action: import("@portable-devshell/shared").TodoTaskControlAction,
        ctxId: string
    ): Promise<JsonValue> {
        return (await this.#requireDescriptor(instance).todo.control(taskId, action, ctxId)) as unknown as JsonValue;
    }

    async decideApproval(instance: string, approvalId: string, decision: "approve" | "deny") {
        return await this.#requireDescriptor(instance).worker.decideApproval(approvalId, {
            decidedBy: "web",
            decision
        });
    }

    async consumeContextMessages(instance: string, ctxId: string, callId: string) {
        const service = this.#requireDescriptor(instance).contextMessages;
        if (service === undefined) {
            throw createError({
                code: errorCodes.envelopeInvalid,
                message: "Context message service is unavailable for this instance.",
                retryable: false
            });
        }
        return await service.consumePending(ctxId, callId);
    }

    async readTodo(
        instance: string,
        input?: import("@portable-devshell/shared").TodoReadInput
    ): Promise<JsonValue> {
        return (await this.#requireDescriptor(instance).todo.read(input)) as unknown as JsonValue;
    }

    listTools(instance: string): ToolDefinition[] {
        return this.#requireDescriptor(instance).worker.listTools();
    }

    async prepareWorkspace(instance: string, workspace: string) {
        return await this.#requireDescriptor(instance).worker.prepareWorkspace(workspace);
    }

    async readAlerts(instance: string, workspace: string) {
        return await this.#requireDescriptor(instance).worker.readAlerts(workspace);
    }

    async releaseAlerts(instance: string, workspace: string): Promise<void> {
        await this.#requireDescriptor(instance).worker.releaseAlerts(workspace);
    }

    async connectInstance(instance: string, reference: string): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        if (!descriptor.enabled) {
            throw createError({
                code: errorCodes.instanceConflict,
                details: { instance, operation: "connect" },
                message: `Instance ${instance} is disabled.`,
                retryable: false
            });
        }

        let snapshot = descriptor.worker.snapshot();
        let ownsLifecycle = false;
        if (!snapshot.ready) {
            if (descriptor.worker.managementMode === "selfManaged") {
                snapshot = await descriptor.worker.refreshStatus();
                if (!snapshot.ready) {
                    throw createError({
                        code: errorCodes.reverseSelfManagedOffline,
                        details: { instance },
                        message: `Instance ${instance} is self-managed and is not connected.`,
                        retryable: true
                    });
                }
            } else {
                snapshot = await descriptor.worker.start();
                ownsLifecycle = true;
            }
        }
        if (descriptor.worker.managementMode !== "selfManaged") {
            this.#instanceRegistry.retainConnectionReference(instance, reference, ownsLifecycle);
        }
        return withTodoSummaries(snapshot, descriptor.todo.summaries()) as unknown as JsonValue;
    }

    async releaseInstanceReference(instance: string, reference: string): Promise<void> {
        const descriptor = this.#requireDescriptor(instance);
        if (descriptor.worker.managementMode === "selfManaged") return;
        if (!this.#instanceRegistry.releaseConnectionReference(instance, reference)) return;
        await descriptor.worker.stop();
        this.#instanceRegistry.clearConnectionOwnership(instance);
    }

    async statusInstance(instance: string): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        const config = this.#getConfig().instances.find((entry) => entry.name === instance);
        return {
            enabled: descriptor.enabled,
            mcpEnabled: descriptor.mcpEnabled,
            name: descriptor.name,
            provider: config?.provider,
            snapshot: withTodoSummaries(descriptor.worker.snapshot(), descriptor.todo.summaries())
        } as unknown as JsonValue;
    }

    async stopInstance(instance: string): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        const snapshot = withTodoSummaries(
            await descriptor.worker.stop(),
            descriptor.todo.summaries()
        );
        this.#instanceRegistry.clearOwned(instance);
        return snapshot as unknown as JsonValue;
    }

    async touchAlerts(instance: string, workspace: string): Promise<void> {
        await this.#requireDescriptor(instance).worker.touchAlerts(workspace);
    }

    async touchTemporaryDirectory(instance: string, path: string): Promise<void> {
        await this.#requireDescriptor(instance).worker.touchTemporaryDirectory(path);
    }

    async writeTodo(instance: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        return (await descriptor.todo.write(
            input as unknown as import("@portable-devshell/shared").TodoWriteInput,
            requireCtxId(context)
        )) as unknown as JsonValue;
    }

    #requireWait(instance: string) {
        const wait = this.#requireDescriptor(instance).wait;
        if (wait === undefined) {
            throw createError({
                code: errorCodes.envelopeInvalid,
                message: `Wait service is unavailable for ${instance}.`,
                retryable: false
            });
        }
        return wait;
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

function withTodoSummaries<T extends object>(snapshot: T, activeTodos: import("@portable-devshell/shared").ActiveTodoSummary[]): T & { activeTodos?: import("@portable-devshell/shared").ActiveTodoSummary[] } {
    return {
        ...snapshot,
        ...(activeTodos.length === 0 ? {} : { activeTodos })
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
