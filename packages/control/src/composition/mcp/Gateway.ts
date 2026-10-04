import type { ToolCallApi } from "@portable-devshell/core/toolcall";
import type {
    McpApprovalPort,
    McpInstanceGateway,
} from "@portable-devshell/mcp";
import {
    createRemoteError,
    controlErrorCodes,
    runtimeErrorCodes,
} from "@portable-devshell/shared";
import type {
    ControlConfig,
    JsonValue,
} from "@portable-devshell/shared";
import type { InstanceRegistry } from "@portable-devshell/core";
import { InstanceConnectionService } from "@portable-devshell/core";
import type { ToolCallProvenanceStore } from "@portable-devshell/core";
import type { McpExtensionService } from "./extension/Service.js";
import type { InstanceDomainRuntimePort } from "../InstanceRuntime.js";

export interface McpInstanceGatewayControlOptions {
    getConfig: () => ControlConfig;
    instanceDomains: InstanceDomainRuntimePort;
    instanceRegistry: InstanceRegistry;
    instanceConnections?: InstanceConnectionService;
    toolProvenance?: ToolCallProvenanceStore;
}

export class McpInstanceGatewayControl implements McpInstanceGateway {
    readonly approval: McpApprovalPort = {
        listApprovals: async (instance) =>
            await this.#requireApproval(instance).listApprovals(),
        listPendingApprovals: async (instance, ctxId) =>
            await this.#requireApproval(instance).listPendingApprovals(ctxId),
        decideApproval: async (instance, approvalId, decision) =>
            await this.#requireApproval(instance).decideApproval(
                approvalId,
                {
                    decidedBy: "web",
                    decision,
                },
            ),
        cancelApproval: async (instance, approvalId, reason) =>
            await this.#requireApproval(instance).cancel(
                approvalId,
                reason,
            ),
    };
    readonly #getConfig: () => ControlConfig;
    readonly #instanceDomains: InstanceDomainRuntimePort;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #instanceConnections: InstanceConnectionService;
    readonly #toolProvenance?: ToolCallProvenanceStore;
    #extensions?: McpExtensionService;
    #toolCalls?: ToolCallApi;
    #modelCommands: (instance: string) => readonly string[] = () => [];

    constructor(options: McpInstanceGatewayControlOptions) {
        this.#getConfig = options.getConfig;
        this.#instanceDomains = options.instanceDomains;
        this.#instanceRegistry = options.instanceRegistry;
        this.#instanceConnections =
            options.instanceConnections ??
            new InstanceConnectionService(options.instanceRegistry);
        this.#toolProvenance = options.toolProvenance;
    }

    async appendMcpToolCalled(
        instance: string,
        toolName: string,
        context: { requestId?: string; ctxId?: string },
    ): Promise<void> {
        await this.#requireDescriptor(instance).worker.appendMcpToolCalled(
            toolName,
            context,
        );
    }

    assertReady(instance: string): void {
        const descriptor = this.#requireDescriptor(instance);
        if (!descriptor.worker.snapshot().ready) {
            throw createRemoteError({
                code: runtimeErrorCodes.instanceNotReady,
                details: { instance },
                message: `Instance ${instance} is not ready.`,
                retryable: false,
            });
        }
    }

    bindToolCalls(ingress: ToolCallApi): void {
        if (this.#toolCalls !== undefined)
            throw new Error("MCP tool call ingress is already bound.");
        this.#toolCalls = ingress;
    }

    async callTool(
        ...args: Parameters<ToolCallApi["call"]>
    ): Promise<JsonValue> {
        return await this.#requireToolCalls().call(...args);
    }

    #requireToolCalls(): ToolCallApi {
        if (this.#toolCalls === undefined)
            throw new Error("MCP tool call ingress is not bound.");
        return this.#toolCalls;
    }

    async closeToolSession(sessionId: string): Promise<void> {
        await Promise.all(
            this.#instanceRegistry.list().map(async (descriptor) => {
                await descriptor.worker.releaseToolSession(sessionId);
            }),
        );
    }

    environment(instance: string) {
        return this.#requireDescriptor(instance).worker.handshake;
    }

    modelCommands(instance: string): readonly string[] {
        this.#requireDescriptor(instance);
        return this.#modelCommands(instance);
    }

    setModelCommandCatalog(
        provider: (instance: string) => readonly string[],
    ): void {
        this.#modelCommands = provider;
    }

    setExtensionService(service: McpExtensionService): void {
        this.#extensions = service;
    }

    async contextTerminated(
        instance: string,
        ctxId: string,
        reason: "disabled" | "expired",
    ): Promise<void> {
        await this.#extensions?.contextTerminated(instance, ctxId, reason);
    }

    async listInstances(): Promise<JsonValue> {
        const configByName = new Map(
            this.#getConfig().instances.map(
                (instance) => [instance.name, instance] as const,
            ),
        );
        return this.#instanceRegistry.list().map((descriptor) => {
            const config = configByName.get(descriptor.name);
            return {
                enabled: descriptor.enabled,
                mcpEnabled: descriptor.mcpEnabled,
                name: descriptor.name,
                provider: config?.provider,
                snapshot: withTodoSummaries(
                    descriptor.worker.snapshot(),
                    this.#requireTask(descriptor.name).todo.summaries(),
                ),
            };
        }) as unknown as JsonValue;
    }

    async goalContinuation(
        instance: string,
        input: import("@portable-devshell/shared").GoalContinuationInput,
        ctxId: string,
    ): Promise<JsonValue> {
        return await this.#requireTask(instance).goal.continuation(
            ctxId,
            input,
        );
    }

    async manageGoal(
        instance: string,
        input: import("@portable-devshell/shared").GoalManageInput,
        ctxId: string,
    ) {
        return await this.#requireTask(instance).goal.manage(
            ctxId,
            input,
        );
    }

    async readGoal(instance: string, ctxId: string) {
        return await this.#requireTask(instance).goal.read(ctxId);
    }

    async recordGoalReentry(
        instance: string,
        ctxId: string,
        progressEpoch?: number,
    ): Promise<void> {
        await this.#requireTask(instance).goal.recordReentry(
            ctxId,
            progressEpoch,
        );
    }

    async touchGoal(
        instance: string,
        ctxId: string,
        kind: import("@portable-devshell/shared").GoalActivityKind = "execution",
    ): Promise<void> {
        await this.#requireTask(instance).goal.touch(ctxId, kind);
    }

    async readToolCalls(instance: string, ctxId: string, limit: number) {
        const records = await this.#requireDescriptor(
            instance,
        ).worker.readToolCalls({ ctxId, limit });
        if (this.#toolProvenance === undefined) return records;
        return await this.#toolProvenance
            .decorate(instance, records)
            .catch(() => records);
    }

    hasActiveToolCalls(instance: string, ctxId: string) {
        return this.#requireDescriptor(instance).worker.hasActiveToolCalls(
            ctxId,
        );
    }

    async readMcpAppEvents(instance: string, fromSeq: number) {
        const result =
            this.#requireDescriptor(instance).worker.subscribe(fromSeq);
        return result.kind === "gap"
            ? { events: [], gap: true, lastSeq: result.lastSeq }
            : { events: result.events, gap: false, lastSeq: result.lastSeq };
    }

    async controlTodo(
        instance: string,
        taskId: string,
        action: import("@portable-devshell/shared").TodoTaskControlAction,
        ctxId: string,
        expectedRevision?: number,
    ): Promise<JsonValue> {
        return (await this.#requireTask(instance).todo.control(
            taskId,
            action,
            ctxId,
            expectedRevision,
        )) as unknown as JsonValue;
    }

    async readTodo(
        instance: string,
        input?: import("@portable-devshell/shared").TodoReadInput,
    ): Promise<JsonValue> {
        return (await this.#requireTask(instance).todo.read(
            input,
        )) as unknown as JsonValue;
    }

    async prepareWorkspace(instance: string, workspace: string) {
        return await this.#requireDescriptor(instance).worker.prepareWorkspace(
            workspace,
        );
    }

    async readAlerts(instance: string, workspace: string) {
        return await this.#requireDescriptor(instance).worker.readAlerts(
            workspace,
        );
    }

    async releaseAlerts(instance: string, workspace: string): Promise<void> {
        await this.#requireDescriptor(instance).worker.releaseAlerts(workspace);
    }

    async connectInstance(
        instance: string,
        reference: string,
    ): Promise<JsonValue> {
        const { snapshot } = await this.#instanceConnections.acquire(
            instance,
            reference,
        );
        const descriptor = this.#requireDescriptor(instance);
        return withTodoSummaries(
            snapshot,
            this.#requireTask(descriptor.name).todo.summaries(),
        ) as unknown as JsonValue;
    }

    async releaseInstanceReference(
        instance: string,
        reference: string,
    ): Promise<void> {
        await this.#instanceConnections.release(instance, reference);
    }

    async statusInstance(instance: string): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        const config = this.#getConfig().instances.find(
            (entry) => entry.name === instance,
        );
        return {
            enabled: descriptor.enabled,
            mcpEnabled: descriptor.mcpEnabled,
            name: descriptor.name,
            provider: config?.provider,
            snapshot: withTodoSummaries(
                descriptor.worker.snapshot(),
                this.#requireTask(descriptor.name).todo.summaries(),
            ),
        } as unknown as JsonValue;
    }

    async stopInstance(instance: string): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        const snapshot = withTodoSummaries(
            await descriptor.worker.stop(),
            this.#requireTask(descriptor.name).todo.summaries(),
        );
        this.#instanceRegistry.clearOwned(instance);
        return snapshot as unknown as JsonValue;
    }

    async touchAlerts(instance: string, workspace: string) {
        return await this.#requireDescriptor(instance).worker.touchAlerts(
            workspace,
        );
    }

    async touchTemporaryDirectory(
        instance: string,
        path: string,
    ): Promise<void> {
        await this.#requireDescriptor(instance).worker.touchTemporaryDirectory(
            path,
        );
    }


    #requireApproval(instance: string) {
        const approval = this.#instanceDomains.approval(instance);
        if (approval !== undefined) return approval;
        this.#requireDescriptor(instance);
        throw new Error(`Instance ${instance} approval runtime is unavailable.`);
    }

    #requireTask(instance: string) {
        const task = this.#instanceDomains.task(instance);
        if (task !== undefined) return task;
        this.#requireDescriptor(instance);
        throw new Error(`Instance ${instance} task runtime is unavailable.`);
    }

    #requireDescriptor(instance: string) {
        const descriptor = this.#instanceRegistry.get(instance);
        if (descriptor !== undefined) {
            return descriptor;
        }
        throw createRemoteError({
            code: controlErrorCodes.instanceNotFound,
            details: { instance },
            message: `Instance ${instance} was not found.`,
            retryable: false,
        });
    }
}

function withTodoSummaries<T extends object>(
    snapshot: T,
    activeTodos: import("@portable-devshell/shared").ActiveTodoSummary[],
): T & {
    activeTodos?: import("@portable-devshell/shared").ActiveTodoSummary[];
} {
    return {
        ...snapshot,
        ...(activeTodos.length === 0 ? {} : { activeTodos }),
    };
}
