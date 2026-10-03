import type { ToolCallHookValue, ToolCallPipeline } from "@portable-devshell/core";
import type {
    McpApprovalPort,
    McpInstanceGateway,
} from "@portable-devshell/mcp";
import {
    createRemoteError,
    contextErrorCodes,
    controlErrorCodes,
    runtimeErrorCodes,
} from "@portable-devshell/shared";
import type {
    ArtifactViewImageInput,
    ArtifactViewImageResult,
    ControlConfig,
    JsonValue,
    ToolCallContext,
    ToolDefinition,
} from "@portable-devshell/shared";
import type { InstanceRegistry } from "../../control/instance/registry/Registry.js";
import { InstanceConnectionService } from "../../control/instance/registry/Connection.js";
import type { ToolCallProvenanceStore } from "../../instance/execution/tool/Provenance.js";
import type { ArtifactService } from "../../control/artifact/Service.js";
import type { McpExtensionService } from "./extension/Service.js";

export interface McpInstanceGatewayControlOptions {
    getConfig: () => ControlConfig;
    instanceRegistry: InstanceRegistry;
    instanceConnections?: InstanceConnectionService;
    toolProvenance?: ToolCallProvenanceStore;
}

export class McpInstanceGatewayControl implements McpInstanceGateway {
    readonly approval: McpApprovalPort = {
        listApprovals: async (instance) =>
            await this.#requireDescriptor(instance).approval.listApprovals(),
        listPendingApprovals: async (instance, ctxId) =>
            await this.#requireDescriptor(
                instance,
            ).approval.listPendingApprovals(ctxId),
        decideApproval: async (instance, approvalId, decision) =>
            await this.#requireDescriptor(instance).approval.decideApproval(
                approvalId,
                {
                    decidedBy: "web",
                    decision,
                },
            ),
        cancelApproval: async (instance, approvalId, reason) =>
            await this.#requireDescriptor(instance).approval.cancel(approvalId, reason),
    };
    readonly #getConfig: () => ControlConfig;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #instanceConnections: InstanceConnectionService;
    readonly #toolProvenance?: ToolCallProvenanceStore;
    #extensions?: McpExtensionService;
    #toolCalls?: Pick<ToolCallPipeline, "call" | "callOperation">;
    #modelCommands: (instance: string) => readonly string[] = () => [];

    constructor(options: McpInstanceGatewayControlOptions) {
        this.#getConfig = options.getConfig;
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

    bindToolCalls(ingress: Pick<ToolCallPipeline, "call" | "callOperation">): void {
        if (this.#toolCalls !== undefined)
            throw new Error("MCP tool call ingress is already bound.");
        this.#toolCalls = ingress;
    }

    async callToolOperation<T extends JsonValue>(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string, input: JsonValue, finalValue: ToolCallHookValue) => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        return await this.#requireToolCalls().callOperation(
            instance, toolName, input, context, operation, signal,
        );
    }

    async callTool(
        ...args: Parameters<ToolCallPipeline["call"]>
    ): Promise<JsonValue> {
        return await this.#requireToolCalls().call(...args);
    }

    #requireToolCalls(): Pick<ToolCallPipeline, "call" | "callOperation"> {
        if (this.#toolCalls === undefined)
            throw new Error("MCP tool call ingress is not bound.");
        return this.#toolCalls;
    }

    async invokeToolInternal(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        return await this.#requireDescriptor(
            instance,
        ).worker.invokeToolInternal(toolName, input, context, signal);
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

    listExtensionTools(instance: string): readonly ToolDefinition[] {
        this.#requireDescriptor(instance);
        return this.#extensions?.listTools() ?? [];
    }

    async callExtensionTool(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        callId: string,
        signal?: AbortSignal,
    ) {
        this.#requireDescriptor(instance);
        const extensions = this.#extensions;
        if (extensions === undefined)
            throw new Error("MCP Extension service is unavailable.");
        return await extensions.callTool(
            toolName,
            input,
            {
                callId,
                instance,
                ...(context.ctxId === undefined ? {} : { ctxId: context.ctxId }),
                ...(context.requestId === undefined
                    ? {}
                    : { requestId: context.requestId }),
                ...(context.workspace === undefined
                    ? {}
                    : { workspace: context.workspace }),
            },
            signal,
        );
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
                    descriptor.todo.summaries(),
                ),
            };
        }) as unknown as JsonValue;
    }

    async createWait(
        instance: string,
        input: import("@portable-devshell/shared").WaitCreateInput,
    ) {
        return await this.#requireWait(instance).create(input);
    }

    async cancelWait(instance: string, waitId: string) {
        return await this.#requireWait(instance).cancel(waitId);
    }

    async claimWaitRecovery(instance: string, waitId: string, claimId: string) {
        return await this.#requireWait(instance).claimRecovery(waitId, claimId);
    }

    async completeWaitRecovery(
        instance: string,
        waitId: string,
        claimId: string,
    ) {
        return await this.#requireWait(instance).completeRecovery(
            waitId,
            claimId,
        );
    }

    async dismissWaitRecovery(
        instance: string,
        waitId: string,
        recoveryMessageId: string,
    ) {
        return await this.#requireWait(instance).dismissRecovery(
            waitId,
            recoveryMessageId,
        );
    }

    async markWaitRecoveryAttempted(
        instance: string,
        waitId: string,
        claimId: string,
        goalProgressEpoch?: number,
    ) {
        return await this.#requireWait(instance).markRecoveryAttempted(
            waitId,
            claimId,
            goalProgressEpoch,
        );
    }

    async detachWait(instance: string, waitId: string) {
        return await this.#requireWait(instance).detach(waitId);
    }

    async reattachWait(instance: string, waitId: string, ownerCallId?: string) {
        return await this.#requireWait(instance).reattach(waitId, ownerCallId);
    }

    async releaseWaitRecovery(
        instance: string,
        waitId: string,
        claimId: string,
    ) {
        return await this.#requireWait(instance).releaseRecovery(
            waitId,
            claimId,
        );
    }

    async rejectWaitRecovery(
        instance: string,
        waitId: string,
        claimId: string,
    ) {
        return await this.#requireWait(instance).rejectRecovery(
            waitId,
            claimId,
        );
    }

    async disableWaitRecovery(instance: string, waitId: string) {
        return await this.#requireWait(instance).disableRecovery(waitId);
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

    async observeTmuxTask(
        instance: string,
        taskId: string,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        return await this.#requireDescriptor(instance).worker.observeTmuxTask(
            taskId,
            context,
            signal,
        );
    }

    async goalContinuation(
        instance: string,
        input: import("@portable-devshell/shared").GoalContinuationInput,
        ctxId: string,
    ): Promise<JsonValue> {
        return await this.#requireDescriptor(instance).goal.continuation(
            ctxId,
            input,
        );
    }

    async manageGoal(
        instance: string,
        input: import("@portable-devshell/shared").GoalManageInput,
        ctxId: string,
    ) {
        return await this.#requireDescriptor(instance).goal.manage(
            ctxId,
            input,
        );
    }

    async readGoal(instance: string, ctxId: string) {
        return await this.#requireDescriptor(instance).goal.read(ctxId);
    }

    async recordGoalReentry(
        instance: string,
        ctxId: string,
        progressEpoch?: number,
    ): Promise<void> {
        await this.#requireDescriptor(instance).goal.recordReentry(
            ctxId,
            progressEpoch,
        );
    }

    async touchGoal(
        instance: string,
        ctxId: string,
        kind: import("@portable-devshell/shared").GoalActivityKind = "execution",
    ): Promise<void> {
        await this.#requireDescriptor(instance).goal.touch(ctxId, kind);
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

    async readWorkspaceEvents(instance: string, fromSeq: number) {
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
        return (await this.#requireDescriptor(instance).todo.control(
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
        return (await this.#requireDescriptor(instance).todo.read(
            input,
        )) as unknown as JsonValue;
    }

    listTools(instance: string): ToolDefinition[] {
        return this.#requireDescriptor(instance).worker.listTools();
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
            descriptor.todo.summaries(),
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
                descriptor.todo.summaries(),
            ),
        } as unknown as JsonValue;
    }

    async stopInstance(instance: string): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        const snapshot = withTodoSummaries(
            await descriptor.worker.stop(),
            descriptor.todo.summaries(),
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

    async writeTodo(
        instance: string,
        input: JsonValue,
        context: ToolCallContext,
    ): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        const ctxId = requireCtxId(context);
        return (await descriptor.todo.write(
            input as unknown as import("@portable-devshell/shared").TodoWriteInput,
            ctxId,
        )) as unknown as JsonValue;
    }

    #requireWait(instance: string) {
        const wait = this.#requireDescriptor(instance).wait;
        if (wait === undefined) {
            throw createRemoteError({
                code: controlErrorCodes.methodNotFound,
                message: `Wait service is unavailable for ${instance}.`,
                retryable: false,
            });
        }
        return wait;
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

function requireCtxId(context: ToolCallContext): string {
    if (context.ctxId !== undefined && context.ctxId.length > 0) {
        return context.ctxId;
    }
    throw createRemoteError({
        code: contextErrorCodes.invalid,
        message: "todo_write requires a validated ctxId.",
        retryable: false,
    });
}

export function decorateMcpInstanceGatewayArtifact(
    base: McpInstanceGateway,
    artifactService: ArtifactService,
): McpInstanceGateway {
    return new Proxy(base, {
        get(target, property, receiver) {
            if (property === "viewArtifactImage") {
                return async (
                    defaultInstance: string,
                    input: ArtifactViewImageInput,
                    signal?: AbortSignal,
                ): Promise<ArtifactViewImageResult> =>
                    await artifactService.viewImage(
                        input,
                        defaultInstance,
                        signal,
                    );
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
