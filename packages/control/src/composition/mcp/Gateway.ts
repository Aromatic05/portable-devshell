import type { McpInstanceGateway } from "@portable-devshell/mcp";
import {
    createError,
    errorCodes,
    toControlErrorBody,
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

export interface McpInstanceGatewayControlOptions {
    getConfig: () => ControlConfig;
    instanceRegistry: InstanceRegistry;
    instanceConnections?: InstanceConnectionService;
    now?: () => number;
    toolProvenance?: ToolCallProvenanceStore;
}

const TODO_REPORT_BUCKET_CAPACITY = 2;

const TODO_REPORT_REFILL_INTERVAL_MS = 30_000;

const TODO_REPORT_CONVERSATION_WINDOW = 400;

const TODO_ACCESS_BUCKET_CAPACITY = 2;

const TODO_ACCESS_REFILL_INTERVAL_MS = 30_000;

const TODO_INVALID_WINDOW_MS = 120_000;

const TODO_INVALID_DISABLE_MS = 300_000;

const TODO_INVALID_LIMIT = 3;

interface TodoAccessPolicyState {
    lastRefillAt: number;
    tokens: number;
}

interface TodoReportPolicyState {
    lastRefillAt: number;
    lastReportMessage?: string;
    tokens: number;
}

interface TodoInvalidPolicyState {
    disabledUntil?: number;
    invalidAt: number[];
}

export class McpInstanceGatewayControl implements McpInstanceGateway {
    readonly #getConfig: () => ControlConfig;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #instanceConnections: InstanceConnectionService;
    readonly #now: () => number;
    readonly #toolProvenance?: ToolCallProvenanceStore;
    readonly #todoAccessPolicy = new Map<string, TodoAccessPolicyState>();
    readonly #todoAccessPolicyOperations = new Map<string, Promise<void>>();
    readonly #todoReportPolicy = new Map<string, TodoReportPolicyState>();
    readonly #todoReportPolicyOperations = new Map<string, Promise<void>>();
    readonly #todoInvalidPolicy = new Map<string, TodoInvalidPolicyState>();
    #modelCommands: (instance: string) => readonly string[] = () => [];

    constructor(options: McpInstanceGatewayControlOptions) {
        this.#getConfig = options.getConfig;
        this.#instanceRegistry = options.instanceRegistry;
        this.#instanceConnections =
            options.instanceConnections ??
            new InstanceConnectionService(options.instanceRegistry);
        this.#now = options.now ?? Date.now;
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
            throw createError({
                code: errorCodes.coreInstanceNotReady,
                details: { instance },
                message: `Instance ${instance} is not ready.`,
                retryable: false,
            });
        }
    }

    async beforeTodoToolCall(
        instance: string,
        toolName: string,
        context: ToolCallContext,
    ): Promise<void> {
        const ctxId = context.ctxId;
        if (ctxId === undefined || !isTodoTool(toolName)) return;
        this.#assertTodoEnabled(instance, ctxId);
        if (toolName === "todo_read" || toolName === "todo_write") {
            await this.#consumeTodoAccessToken(instance, ctxId);
        }
    }

    async callToolOperation<T extends JsonValue>(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string, input: JsonValue) => Promise<T>,
        signal?: AbortSignal,
        onFeedback?: (feedback: readonly string[]) => void,
    ): Promise<T> {
        return await this.#requireDescriptor(instance).worker.callToolOperation(
            toolName,
            input,
            context,
            operation,
            signal,
            onFeedback,
        );
    }

    async callTool(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (
            result: JsonValue,
            callId: string,
        ) => Promise<JsonValue>,
        invocationInput?: (input: JsonValue) => Promise<JsonValue> | JsonValue,
        onFeedback?: (feedback: readonly string[]) => void,
    ): Promise<JsonValue> {
        const descriptor = this.#requireDescriptor(instance);
        return await descriptor.worker.callTool(
            toolName,
            input,
            context,
            signal,
            transformResult,
            invocationInput,
            undefined,
            "host",
            onFeedback,
        );
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

    async listApprovals(instance: string) {
        return await this.#requireDescriptor(instance).worker.listApprovals();
    }

    async listPendingApprovals(instance: string, ctxId?: string) {
        return await this.#requireDescriptor(
            instance,
        ).worker.listPendingApprovals(ctxId);
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

    async decideApproval(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny",
    ) {
        return await this.#requireDescriptor(instance).worker.decideApproval(
            approvalId,
            {
                decidedBy: "web",
                decision,
            },
        );
    }

    async cancelApproval(
        instance: string,
        approvalId: string,
        reason?: string,
    ) {
        return await this.#requireDescriptor(instance).worker.cancelApproval(
            approvalId,
            reason,
        );
    }

    async failContextMessages(instance: string, ctxId: string, reason: string) {
        const service = this.#requireDescriptor(instance).contextMessages;
        if (service === undefined) return [];
        return await service.failPending(ctxId, reason);
    }

    async consumeContextMessages(
        instance: string,
        ctxId: string,
        callId: string,
    ) {
        const service = this.#requireDescriptor(instance).contextMessages;
        if (service === undefined) {
            throw createError({
                code: errorCodes.envelopeInvalid,
                message:
                    "Context message service is unavailable for this instance.",
                retryable: false,
            });
        }
        return await service.consumePending(ctxId, callId);
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

    async touchAlerts(instance: string, workspace: string): Promise<void> {
        await this.#requireDescriptor(instance).worker.touchAlerts(workspace);
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
        try {
            return (await descriptor.todo.write(
                input as unknown as import("@portable-devshell/shared").TodoWriteInput,
                ctxId,
            )) as unknown as JsonValue;
        } catch (error) {
            if (toControlErrorBody(error)?.code === errorCodes.todoInvalid) {
                this.#recordTodoInvalid(instance, ctxId);
            }
            throw error;
        }
    }

    async reportTodo(
        instance: string,
        message: string,
        callId: string,
        context: ToolCallContext,
    ): Promise<void> {
        const ctxId = requireCtxId(context);
        const key = todoPolicyKey(instance, ctxId);
        await this.#withTodoReportPolicy(key, async () => {
            const descriptor = this.#requireDescriptor(instance);
            await this.beforeTodoToolCall(instance, "todo_report", context);
            const state = await this.#syncTodoReportPolicy(instance, ctxId);
            this.#refillTodoReportBucket(state, this.#now());
            const replyCommentId =
                await descriptor.contextMessages?.pendingReplyCommentId(ctxId);

            if (replyCommentId === undefined) {
                if (state.lastReportMessage === message) {
                    this.#recordTodoInvalid(instance, ctxId);
                    throw createError({
                        code: errorCodes.todoInvalid,
                        details: { ctxId, reason: "duplicate" },
                        message:
                            "todo_report rejected an unchanged consecutive report. Continue useful work until there is new information.",
                        retryable: false,
                    });
                }
                if (state.tokens < 1) {
                    this.#recordTodoInvalid(instance, ctxId);
                    throw todoUseOtherToolsError();
                }
            }

            await descriptor.conversation.recordReport({
                callId,
                ctxId,
                ...(replyCommentId === undefined ? {} : { replyCommentId }),
                text: message,
            });
            if (replyCommentId === undefined) state.tokens -= 1;
            state.lastReportMessage = message;
        });
    }

    async #syncTodoReportPolicy(
        instance: string,
        ctxId: string,
    ): Promise<TodoReportPolicyState> {
        const key = todoPolicyKey(instance, ctxId);
        let state = this.#todoReportPolicy.get(key);
        if (state === undefined) {
            state = {
                lastRefillAt: this.#now(),
                tokens: TODO_REPORT_BUCKET_CAPACITY,
            };
            this.#todoReportPolicy.set(key, state);
        }

        const entries = await this.#requireDescriptor(
            instance,
        ).conversation.list({
            ctxId,
            limit: TODO_REPORT_CONVERSATION_WINDOW,
        });
        state.lastReportMessage = [...entries]
            .reverse()
            .find((entry) => entry.kind === "report")?.text;
        return state;
    }

    #refillTodoReportBucket(state: TodoReportPolicyState, now: number): void {
        const elapsed = Math.max(0, now - state.lastRefillAt);
        state.tokens = Math.min(
            TODO_REPORT_BUCKET_CAPACITY,
            state.tokens + elapsed / TODO_REPORT_REFILL_INTERVAL_MS,
        );
        state.lastRefillAt = now;
    }

    async #consumeTodoAccessToken(
        instance: string,
        ctxId: string,
    ): Promise<void> {
        const key = todoPolicyKey(instance, ctxId);
        await this.#withPolicyLock(
            this.#todoAccessPolicyOperations,
            key,
            async () => {
                let state = this.#todoAccessPolicy.get(key);
                if (state === undefined) {
                    state = {
                        lastRefillAt: this.#now(),
                        tokens: TODO_ACCESS_BUCKET_CAPACITY,
                    };
                    this.#todoAccessPolicy.set(key, state);
                }
                const now = this.#now();
                const elapsed = Math.max(0, now - state.lastRefillAt);
                state.tokens = Math.min(
                    TODO_ACCESS_BUCKET_CAPACITY,
                    state.tokens + elapsed / TODO_ACCESS_REFILL_INTERVAL_MS,
                );
                state.lastRefillAt = now;
                if (state.tokens < 1) {
                    this.#recordTodoInvalid(instance, ctxId);
                    throw todoUseOtherToolsError();
                }
                state.tokens -= 1;
            },
        );
    }

    #assertTodoEnabled(instance: string, ctxId: string): void {
        const key = todoPolicyKey(instance, ctxId);
        const state = this.#todoInvalidPolicy.get(key);
        if (state === undefined) return;

        const now = this.#now();
        if (state.disabledUntil !== undefined) {
            if (now < state.disabledUntil) throw todoUseOtherToolsError();
            this.#todoInvalidPolicy.delete(key);
            return;
        }

        state.invalidAt = state.invalidAt.filter(
            (timestamp) => now - timestamp < TODO_INVALID_WINDOW_MS,
        );
        if (state.invalidAt.length === 0) this.#todoInvalidPolicy.delete(key);
    }

    #recordTodoInvalid(instance: string, ctxId: string): void {
        const key = todoPolicyKey(instance, ctxId);
        const now = this.#now();
        const previous = this.#todoInvalidPolicy.get(key);
        if (
            previous?.disabledUntil !== undefined &&
            now < previous.disabledUntil
        )
            return;

        const invalidAt = (previous?.invalidAt ?? []).filter(
            (timestamp) => now - timestamp < TODO_INVALID_WINDOW_MS,
        );
        invalidAt.push(now);
        this.#todoInvalidPolicy.set(
            key,
            invalidAt.length > TODO_INVALID_LIMIT
                ? {
                      disabledUntil: now + TODO_INVALID_DISABLE_MS,
                      invalidAt: [],
                  }
                : { invalidAt },
        );
    }

    async #withTodoReportPolicy<T>(
        key: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        return await this.#withPolicyLock(
            this.#todoReportPolicyOperations,
            key,
            operation,
        );
    }

    async #withPolicyLock<T>(
        operations: Map<string, Promise<void>>,
        key: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        const previous = operations.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const current = previous
            .catch(() => undefined)
            .then(async () => await gate);
        operations.set(key, current);
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
            if (operations.get(key) === current) {
                operations.delete(key);
            }
        }
    }

    #requireWait(instance: string) {
        const wait = this.#requireDescriptor(instance).wait;
        if (wait === undefined) {
            throw createError({
                code: errorCodes.envelopeInvalid,
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
        throw createError({
            code: errorCodes.instanceMissing,
            details: { instance },
            message: `Instance ${instance} was not found.`,
            retryable: false,
        });
    }
}

function todoPolicyKey(instance: string, ctxId: string): string {
    return `${instance}\u0000${ctxId}`;
}

function isTodoTool(toolName: string): boolean {
    return (
        toolName === "todo_read" ||
        toolName === "todo_report" ||
        toolName === "todo_write"
    );
}

function todoUseOtherToolsError() {
    return createError({
        code: errorCodes.todoInvalid,
        details: { action: "use_other_tools" },
        message:
            "You have performed too many useless operations. Use other tools.",
        retryable: false,
    });
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
    throw createError({
        code: errorCodes.mcpContextInvalid,
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
