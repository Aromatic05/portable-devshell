import {
    createError,
    errorCodes,
    mergeComments,
    resolveResultHints,
    toControlErrorBody,
    type JsonValue,
    type McpContextEnvironment,
    type McpContextRecord,
    type ToolCallContext
} from "@portable-devshell/shared";

import { McpContextRegistry } from "../context/McpContextRegistry.js";
import { createMcpContextSelector, type McpContextSelector } from "../context/McpContextSelector.js";
import {
    isMcpGoalGateway,
    isMcpTmuxWaitGateway,
    type McpInstanceGateway,
    type McpTmuxWaitGateway,
} from "../instance/McpInstanceGateway.js";
import type { McpToolCatalogArtifactName } from "../tool/catalog/McpToolCatalogArtifact.js";
import type { McpToolCatalogInstanceName } from "../tool/catalog/McpToolCatalogInstance.js";
import type { McpToolCatalogInteractionName } from "../tool/catalog/McpToolCatalogInteraction.js";
import type { McpToolCatalogTodoName } from "../tool/catalog/McpToolCatalogTodo.js";
import { throwIfMcpEndpointAborted, waitForMcpEndpointAbortable } from "./McpEndpointCancellation.js";
import { mcpLegacyToolTombstone, resolveMcpLegacyTool } from "./McpEndpointCompatibility.js";
import { attachMcpComments } from "./McpEndpointFeedback.js";
import type { McpEndpointCatalog, McpEndpointCatalogWorker } from "./McpEndpointCatalog.js";
import { readMcpRoutedInput } from "./McpEndpointInput.js";
import type { McpEndpointCallContext, McpEndpointWorkerPort } from "./McpEndpointPort.js";
import { McpNativeToolResult, type McpEndpointResult } from "./McpEndpointResult.js";
import { McpEndpointHandlerArtifact } from "./handler/McpEndpointHandlerArtifact.js";
import { McpEndpointHandlerEnvironment } from "./handler/McpEndpointHandlerEnvironment.js";
import { McpEndpointHandlerInstance } from "./handler/McpEndpointHandlerInstance.js";
import { McpEndpointHandlerInteraction } from "./handler/McpEndpointHandlerInteraction.js";
import { McpEndpointHandlerTodo } from "./handler/McpEndpointHandlerTodo.js";
import { McpEndpointHandlerWorker } from "./handler/McpEndpointHandlerWorker.js";
import { auditMcpEndpointTool, assertMcpEndpointReady, mcpEndpointToolNotExposed } from "./handler/McpEndpointHandlerSupport.js";

export type {
    McpEndpointCallContext,
    McpEndpointEnvironmentHandshake,
    McpEndpointWorkerPort
} from "./McpEndpointPort.js";

export interface McpEndpointDispatchOptions {
    catalog: McpEndpointCatalog;
    contextRegistry?: McpContextRegistry;
    contextSelector?: McpContextSelector;
    gateway?: McpInstanceGateway;
    instanceName: string;
    readyWaitMs?: number;
    tmuxWaitPollMs?: number;
    worker: McpEndpointWorkerPort;
}

const MCP_TMUX_WAIT_POLL_MS = 1_000;
const MCP_TMUX_RESUME_BLOCK_MS = 60 * 60_000;

export class McpEndpointDispatch {
    readonly #artifact: McpEndpointHandlerArtifact;
    readonly #catalog: McpEndpointCatalog;
    readonly #contextRegistry: McpContextRegistry;
    readonly #contextSelector: McpContextSelector;
    readonly #environment: McpEndpointHandlerEnvironment;
    readonly #gateway?: McpInstanceGateway;
    readonly #instance: McpEndpointHandlerInstance;
    readonly #instanceName: string;
    readonly #interaction: McpEndpointHandlerInteraction;
    readonly #tmuxWaitPollMs: number;
    readonly #tmuxWaitRestores = new Map<string, Promise<void>>();
    readonly #tmuxWaitTrackers = new Map<string, { controller: AbortController; promise: Promise<JsonValue> }>();
    readonly #todo: McpEndpointHandlerTodo;
    readonly #worker: McpEndpointWorkerPort;
    readonly #workerHandler: McpEndpointHandlerWorker;

    constructor(options: McpEndpointDispatchOptions) {
        this.#catalog = options.catalog;
        this.#contextRegistry = options.contextRegistry ?? new McpContextRegistry();
        this.#contextSelector = options.contextSelector ?? createMcpContextSelector("explicit");
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#tmuxWaitPollMs = options.tmuxWaitPollMs ?? MCP_TMUX_WAIT_POLL_MS;
        this.#worker = options.worker;
        const controlOptions = {
            gateway: options.gateway,
            instanceName: options.instanceName
        };
        this.#artifact = new McpEndpointHandlerArtifact(controlOptions);
        this.#environment = new McpEndpointHandlerEnvironment({
            contextRegistry: this.#contextRegistry,
            contextSelector: this.#contextSelector,
            gateway: options.gateway,
            instanceName: options.instanceName,
            worker: options.worker
        });
        this.#instance = new McpEndpointHandlerInstance({
            ...controlOptions,
            contextRegistry: this.#contextRegistry
        });
        this.#interaction = new McpEndpointHandlerInteraction({
            ...controlOptions,
            contextSelector: this.#contextSelector
        });
        this.#todo = new McpEndpointHandlerTodo({
            ...controlOptions,
            contextSelector: this.#contextSelector
        });
        this.#workerHandler = new McpEndpointHandlerWorker({
            catalog: options.catalog,
            gateway: options.gateway,
            instanceName: options.instanceName,
            readyWaitMs: options.readyWaitMs,
            worker: options.worker
        });
    }

    assertReady(
        worker: Pick<McpEndpointCatalogWorker, "snapshot"> = this.#worker,
        instanceName: string = this.#instanceName
    ): void {
        assertMcpEndpointReady(worker, instanceName);
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal
    ): Promise<McpEndpointResult> {
        throwIfMcpEndpointAborted(signal);
        const compatibility = resolveMcpLegacyTool(toolName);
        if (compatibility?.kind === "tombstone") {
            return mcpLegacyToolTombstone(toolName, compatibility);
        }
        if (compatibility?.kind === "alias") {
            toolName = compatibility.replacement;
        }
        const snapshot = this.#catalog.snapshot();
        const known = snapshot.merged.find((entry) => entry.definition.name === toolName);
        const selected = snapshot.exposed.find((entry) => entry.definition.name === toolName);

        if (known?.owner === "environment") {
            await this.#restoreTmuxWaits(this.#instanceName);
            return await this.#environment.call(
                toolName,
                input,
                requestContext,
                selected !== undefined,
                signal
            );
        }

        if (selected === undefined) {
            throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }

        const resolvedContext = await this.#contextSelector.resolve(
            this.#contextRegistry,
            input,
            requestContext,
            this.#instanceName,
        );
        input = resolvedContext.input;
        const appOnlyInteraction = selected.owner === "workspace" && isAppOnlyInteractionTool(toolName);
        const routed = selected.owner === "worker" || selected.owner === "artifact"
            ? readMcpRoutedInput(input, snapshot.instanceRoutingEnabled, this.#instanceName)
            : { input, instance: this.#instanceName };
        await this.#restoreTmuxWaits(routed.instance);
        const context = await this.#createToolContext(
            toolName,
            resolvedContext.record,
            requestContext,
            routed.instance,
            selected.owner === "worker",
            !appOnlyInteraction,
            signal
        );
        if (!appOnlyInteraction && toolName !== "workspace_goal" && context.ctxId !== undefined) {
            await this.#gateway?.touchGoal?.(this.#instanceName, context.ctxId);
        }

        if (appOnlyInteraction) {
            this.#catalog.assertAdaptable(selected.definition);
            const result = await this.#interaction.call(
                toolName as McpToolCatalogInteractionName,
                input,
                context,
                context.requestId ?? "workspace-app",
                signal
            );
            if (toolName === "workspace_wait_interrupt") {
                const waitId = readWorkspaceWaitId(input);
                if (waitId !== undefined) this.#interruptTmuxWaitTracker(this.#instanceName, waitId);
            }
            return result;
        }

        if (
            selected.owner === "todo" || selected.owner === "artifact" ||
            selected.owner === "instance" || selected.owner === "workspace"
        ) {
            const owner = selected.owner;
            this.#catalog.assertAdaptable(selected.definition);
            return await this.#auditControlTool(
                owner,
                toolName,
                input,
                context,
                routed.instance,
                signal
            );
        }

        if (toolName === "tmux_run" && isMcpTmuxWaitGateway(this.#gateway) && readTmuxResume(routed.input)) {
            this.#catalog.assertAdaptable(selected.definition);
            return await auditMcpEndpointTool({
                context,
                gateway: this.#gateway,
                input: routed.input,
                localInstance: this.#instanceName,
                operation: async (callId) => await this.#callTmuxRun(
                    routed.input,
                    context,
                    callId,
                    routed.instance,
                    signal,
                ),
                signal,
                targetInstance: routed.instance,
                toolName,
                worker: this.#worker,
            });
        }

        return await this.#workerHandler.call(
            toolName,
            input,
            context,
            selected.definition,
            snapshot.instanceRoutingEnabled,
            signal,
            async (result, callId) => await this.#attachComments(toolName, result, context, callId, routed.instance)
        );
    }

    async #callTmuxRun(
        input: JsonValue,
        context: ToolCallContext,
        callId: string,
        instance: string,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway) || context.ctxId === undefined) {
            throw new Error("tmux_run resume state is unavailable.");
        }
        const timeout = readTmuxTimeout(input);
        const startedAt = Date.now();
        const initialInput = {
            ...(isRecord(input) ? input : {}),
            wait: "block",
            timeMs: timeout !== undefined && timeout <= MCP_TMUX_RESUME_BLOCK_MS
                ? timeout
                : MCP_TMUX_RESUME_BLOCK_MS,
        } as JsonValue;
        const result = instance === this.#instanceName
            ? await this.#worker.callTool("tmux_run", initialInput, context, signal)
            : await gateway.callTool(instance, "tmux_run", initialInput, context, signal);
        if (!isRecord(result) || !isRecord(result.task) || typeof result.task.id !== "string") {
            throw new Error("tmux_run returned an invalid task result.");
        }
        if (result.task.status !== "running") return result;
        if (timeout !== undefined && timeout <= MCP_TMUX_RESUME_BLOCK_MS) return result;

        const task = result.task.id;
        const goalId = await this.#currentGoalId(instance, context.ctxId);
        const taskId = goalId === undefined ? await this.#currentTaskId(instance, context.ctxId) : undefined;
        let wait = await gateway.createWait(instance, {
            createdByCtxId: context.ctxId,
            ...(timeout === undefined ? {} : { deadlineAt: new Date(startedAt + timeout).toISOString() }),
            ...(goalId === undefined ? {} : { goalId }),
            kind: "tmux",
            ownerCallId: callId,
            ...(taskId === undefined ? {} : { taskId }),
            targetId: task,
        });
        wait = await gateway.detachWait(instance, wait.waitId);
        this.#ensureTmuxWaitTracker(
            wait.waitId,
            task,
            context,
            instance,
            timeout === undefined ? undefined : startedAt + timeout,
        );
        return await this.#attachComments(
            "tmux_run",
            { ...result, detached: true },
            context,
            callId,
            instance,
        );
    }

    async #currentGoalId(instance: string, ctxId: string): Promise<string | undefined> {
        const gateway = this.#gateway;
        if (!isMcpGoalGateway(gateway)) return undefined;
        const goal = await gateway.readGoal(instance, ctxId);
        return goal !== undefined && (goal.status === "active" || goal.status === "blocked")
            ? goal.goalId
            : undefined;
    }

    async #currentTaskId(instance: string, ctxId: string): Promise<string | undefined> {
        const gateway = this.#gateway;
        if (gateway === undefined) return undefined;
        const todo = await gateway.readTodo(instance);
        if (typeof todo !== "object" || todo === null || Array.isArray(todo) || !Array.isArray(todo.tasks)) {
            return undefined;
        }
        const active = todo.tasks.filter((task) => (
            typeof task === "object" && task !== null && !Array.isArray(task) &&
            task.ctxId === ctxId && task.status === "in_progress" && typeof task.taskId === "string"
        ));
        if (active.length !== 1) return undefined;
        const task = active[0];
        return typeof task === "object" && task !== null && !Array.isArray(task)
            ? task.taskId as string
            : undefined;
    }

    #ensureTmuxWaitTracker(
        waitId: string,
        taskId: string,
        context: ToolCallContext,
        instance: string,
        deadlineAt?: number,
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway)) {
            throw new Error("tmux_run resume state is unavailable.");
        }
        const key = `${instance}:${waitId}`;
        const existing = this.#tmuxWaitTrackers.get(key);
        if (existing !== undefined) return existing.promise;
        const controller = new AbortController();
        const tracker = this.#trackTmuxTask(gateway, instance, taskId, context, controller.signal, deadlineAt).then(async (result) => {
            await gateway.resolveWait(instance, waitId, result);
            return result;
        }, async (error: unknown) => {
            if (!controller.signal.aborted) {
                await gateway.cancelWait(instance, waitId).catch(() => undefined);
            }
            throw error;
        }).finally(() => {
            this.#tmuxWaitTrackers.delete(key);
        });
        this.#tmuxWaitTrackers.set(key, { controller, promise: tracker });
        void tracker.catch(() => undefined);
        return tracker;
    }

    async #restoreTmuxWaits(instance: string): Promise<void> {
        if (!isMcpTmuxWaitGateway(this.#gateway)) return;
        const existing = this.#tmuxWaitRestores.get(instance);
        if (existing !== undefined) {
            await existing;
            return;
        }
        const restore = (async () => {
            const waits = await this.#gateway!.listWaits!(instance);
            for (const wait of waits) {
                if (wait.kind !== "tmux" || wait.status !== "detached") continue;
                this.#ensureTmuxWaitTracker(
                    wait.waitId,
                    wait.targetId,
                    { ctxId: wait.createdByCtxId, source: "mcp" },
                    instance,
                    wait.deadlineAt === undefined ? undefined : Date.parse(wait.deadlineAt),
                );
            }
        })().catch(() => undefined);
        this.#tmuxWaitRestores.set(instance, restore);
        await restore;
    }

    async #trackTmuxTask(
        gateway: McpTmuxWaitGateway,
        instance: string,
        taskId: string,
        context: ToolCallContext,
        signal: AbortSignal,
        deadlineAt?: number,
    ): Promise<JsonValue> {
        while (true) {
            throwIfMcpEndpointAborted(signal);
            if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
                return { task: { id: taskId, status: "running" }, timedOut: true };
            }
            try {
                const result = await gateway.observeTmuxTask(instance, taskId, context, signal);
                if (!isTmuxTaskRunning(result, taskId)) return result;
            } catch (error) {
                if (!isRetryableTmuxObservationError(error)) throw error;
            }
            await waitForMcpEndpointAbortable(
                new Promise<void>((resolve) => setTimeout(resolve, Math.min(
                    this.#tmuxWaitPollMs,
                    deadlineAt === undefined ? this.#tmuxWaitPollMs : Math.max(1, deadlineAt - Date.now()),
                ))),
                signal
            );
        }
    }

    #interruptTmuxWaitTracker(instance: string, waitId: string): void {
        this.#tmuxWaitTrackers.get(`${instance}:${waitId}`)?.controller.abort("Workspace interrupted tmux_run");
    }

    async #attachComments(
        toolName: string,
        result: JsonValue,
        context: ToolCallContext,
        callId: string,
        instance: string = this.#instanceName
    ): Promise<JsonValue> {
        if (context.ctxId === undefined) return result;
        const queuedComments = await this.#consumeQueuedComments(instance, context.ctxId, callId);
        const comments = mergeComments(
            queuedComments,
            routedResultHints(toolName, result, instance, this.#instanceName)
        );
        return attachMcpComments(result, comments);
    }

    async #consumeQueuedComments(instance: string, ctxId: string, callId: string): Promise<string[]> {
        const consume = this.#gateway?.consumeContextMessages;
        if (consume === undefined) return [];
        const result = await consume.call(this.#gateway, instance, ctxId, callId);
        return result.comment === undefined ? [] : [result.comment];
    }

    async #createToolContext(
        toolName: string,
        record: McpContextRecord,
        requestContext: McpEndpointCallContext,
        instance: string,
        prepareWorkerState: boolean,
        recordMcpCall: boolean,
        signal?: AbortSignal
    ): Promise<ToolCallContext> {
        const environment = prepareWorkerState
            ? await this.#ensureContextWorkerState(record, instance)
            : contextEnvironment(record, instance);
        const context: ToolCallContext = {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
            source: "mcp",
            ...(environment?.workspace === undefined ? {} : { workspace: environment.workspace })
        };
        if (prepareWorkerState) {
            await this.#touchAlerts(instance, environment!.workspace!);
        }
        if (recordMcpCall) {
            await this.#appendMcpToolCalled(instance, toolName, {
                ctxId: context.ctxId,
                requestId: context.requestId
            });
        }
        throwIfMcpEndpointAborted(signal);
        return context;
    }

    async #ensureContextWorkerState(
        record: Awaited<ReturnType<McpContextRegistry["validateAndTouch"]>>,
        instance: string
    ): Promise<McpContextEnvironment> {
        const environment = contextEnvironment(record, instance);
        if (environment?.workspace === undefined) {
            throw contextWorkspaceRequired(record.ctxId, instance);
        }
        if (environment.temporaryDirectory !== undefined) {
            try {
                await this.#touchTemporaryDirectory(instance, environment.temporaryDirectory);
                return environment;
            } catch (error) {
                if (!isRecoverableContextTemporaryError(error)) {
                    throw error;
                }
            }
        }

        const prepared = await this.#prepareWorkspace(instance, environment.workspace);
        if (prepared === undefined) return environment;
        const updated = await this.#contextRegistry.updateWorkerState(record.ctxId, instance, {
            temporaryDirectory: prepared.temporaryDirectory,
            workspace: prepared.workspace
        });
        return contextEnvironment(updated, instance)!;
    }

    async #appendMcpToolCalled(
        instance: string,
        toolName: string,
        context: { requestId?: string; ctxId?: string }
    ): Promise<void> {
        if (instance === this.#instanceName) {
            await this.#worker.appendMcpToolCalled(toolName, context);
            return;
        }
        if (this.#gateway !== undefined) {
            await this.#gateway.appendMcpToolCalled(instance, toolName, context);
        }
    }

    async #prepareWorkspace(instance: string, workspace: string) {
        if (instance === this.#instanceName) {
            return await this.#worker.prepareWorkspace?.(workspace);
        }
        return await this.#gateway?.prepareWorkspace(instance, workspace);
    }

    async #touchAlerts(instance: string, workspace: string): Promise<void> {
        if (instance === this.#instanceName) {
            await this.#worker.touchAlerts?.(workspace);
            return;
        }
        await this.#gateway?.touchAlerts(instance, workspace);
    }

    async #touchTemporaryDirectory(instance: string, path: string): Promise<void> {
        if (instance === this.#instanceName) {
            await this.#worker.touchTemporaryDirectory?.(path);
            return;
        }
        await this.#gateway?.touchTemporaryDirectory(instance, path);
    }

    async #auditControlTool(
        owner: "artifact" | "instance" | "workspace" | "todo",
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        instance: string,
        signal?: AbortSignal
    ): Promise<McpEndpointResult> {
        let nativeResult: McpNativeToolResult | undefined;
        const structuredResult = await auditMcpEndpointTool({
            context,
            gateway: this.#gateway,
            input,
            localInstance: this.#instanceName,
            operation: async (callId) => {
                const result = await this.#callControlTool(owner, toolName, input, context, callId, signal);
                if (result instanceof McpNativeToolResult) {
                    const structuredContent = await this.#attachComments(toolName, result.structuredContent, context, callId, instance);
                    nativeResult = new McpNativeToolResult({
                        ...(result._meta === undefined ? {} : { _meta: result._meta }),
                        content: result.content,
                        isError: result.isError,
                        structuredContent
                    });
                    return structuredContent;
                }
                return await this.#attachComments(toolName, result, context, callId, instance);
            },
            signal,
            targetInstance: instance,
            toolName,
            worker: this.#worker,
        });
        return nativeResult ?? structuredResult;
    }

    async #callControlTool(
        owner: "artifact" | "instance" | "workspace" | "todo",
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        callId: string,
        signal?: AbortSignal
    ): Promise<McpEndpointResult> {
        switch (owner) {
            case "artifact":
                return await this.#artifact.call(toolName as McpToolCatalogArtifactName, input, context, signal);
            case "instance":
                return await this.#instance.call(toolName as McpToolCatalogInstanceName, input, context, signal);
            case "workspace":
                return await this.#interaction.call(
                    toolName as McpToolCatalogInteractionName,
                    input,
                    context,
                    callId,
                    signal
                );
            case "todo":
                return await this.#todo.call(toolName as McpToolCatalogTodoName, input, context, signal);
        }
    }

}

function isAppOnlyInteractionTool(toolName: string): boolean {
    return toolName === "workspace_reconnect" ||
        toolName === "workspace_snapshot" ||
        toolName === "workspace_watch" ||
        toolName === "workspace_goal_continue" ||
        toolName === "workspace_goal_stop" ||
        toolName === "workspace_question_answer" ||
        toolName === "workspace_wait_interrupt" ||
        toolName === "workspace_task_control" ||
        toolName === "workspace_wait_recover" ||
        toolName === "workspace_approval_decide";
}

function readTmuxResume(input: JsonValue): boolean {
    return isRecord(input) && input.resume === true;
}

function readTmuxTimeout(input: JsonValue): number | undefined {
    if (!isRecord(input) || input.timeout === undefined) return undefined;
    if (typeof input.timeout !== "number" || !Number.isInteger(input.timeout) || input.timeout < 1) {
        throw new Error("tmux_run timeout must be a positive integer in milliseconds.");
    }
    return input.timeout;
}

function isTmuxTaskRunning(result: JsonValue, taskId: string): boolean {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error(`tmux task observation for ${taskId} returned an invalid result.`);
    }
    const task = result.task;
    if (typeof task !== "object" || task === null || Array.isArray(task) || task.id !== taskId || typeof task.status !== "string") {
        throw new Error(`tmux task observation for ${taskId} returned an invalid task.`);
    }
    return task.status === "running";
}

function isRetryableTmuxObservationError(error: unknown): boolean {
    const body = toControlErrorBody(error);
    return body?.retryable === true ||
        body?.code === errorCodes.coreInstanceNotReady ||
        body?.code === errorCodes.coreWorkerRpcDisconnected ||
        body?.code === errorCodes.reverseTransportUnavailable;
}

function readWorkspaceWaitId(input: JsonValue): string | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
    const waitId = input.waitId;
    return typeof waitId === "string" && waitId.trim().length > 0 ? waitId.trim() : undefined;
}

function isRecoverableContextTemporaryError(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return false;
    }
    const code = (error as { code?: unknown }).code;
    return code === "workspace.temporaryUnavailable" || code === "workspace.temporaryInvalid";
}

function contextEnvironment(record: McpContextRecord, instance: string): McpContextEnvironment | undefined {
    return record.environments.find((environment) => environment.instance === instance);
}

function contextWorkspaceRequired(ctxId: string, instance: string) {
    return createError({
        code: errorCodes.mcpContextWorkspaceRequired,
        details: { ctxId, instance },
        message: `No workspace is attached to ${instance} for the current Context. Call instance_connect with an absolute workspace.`,
        retryable: false
    });
}

function routedResultHints(toolName: string, result: JsonValue, instance: string, localInstance: string) {
    const hints = resolveResultHints(toolName, result);
    if (toolName !== "bash_run" || instance === localInstance || !isRecord(result)) return hints;
    const streams = [
        ...(isRecord(result.stdoutArtifact) ? ["stdout"] : []),
        ...(isRecord(result.stderrArtifact) ? ["stderr"] : [])
    ];
    if (streams.length === 0) return hints;
    return hints.map((hint) => hint.code === "bash.outputTruncated"
        ? {
            ...hint,
            text: `Read full ${streams.join(" and ")} with artifact_read using instance ${JSON.stringify(instance)}.`
        }
        : hint
    );
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
