import {
    createError,
    errorCodes,
    mergeComments,
    resolveResultHints,
    toControlErrorBody,
    type GoalActivityKind,
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
import type { WorkspaceAppLeaseStore } from "../workspace/WorkspaceAppLeaseStore.js";
import type { WorkspaceAppPresenceStore } from "../workspace/WorkspaceAppPresenceStore.js";
import { McpWorkspaceReentryArbiter } from "../workspace/McpWorkspaceReentryArbiter.js";
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
    tmuxBlockSyncMs?: number;
    tmuxWaitPollMs?: number;
    worker: McpEndpointWorkerPort;
    workspaceAppLeases?: WorkspaceAppLeaseStore;
    workspaceAppPresence?: WorkspaceAppPresenceStore;
    workspaceLiveBaseUrl?: string;
}

const MCP_TMUX_WAIT_POLL_MS = 1_000;
const MCP_TMUX_BLOCK_SYNC_MS = 3 * 60_000;

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
    readonly #reentry: McpWorkspaceReentryArbiter;
    readonly #tmuxBlockSyncMs: number;
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
        this.#reentry = new McpWorkspaceReentryArbiter({
            contextRegistry: this.#contextRegistry,
            gateway: options.gateway,
            instanceName: options.instanceName,
        });
        this.#tmuxBlockSyncMs = options.tmuxBlockSyncMs ?? MCP_TMUX_BLOCK_SYNC_MS;
        this.#tmuxWaitPollMs = options.tmuxWaitPollMs ?? MCP_TMUX_WAIT_POLL_MS;
        this.#worker = options.worker;
        const controlOptions = {
            contextRegistry: this.#contextRegistry,
            gateway: options.gateway,
            instanceName: options.instanceName,
            workspaceAppLeases: options.workspaceAppLeases,
            workspaceAppPresence: options.workspaceAppPresence,
            workspaceLiveBaseUrl: options.workspaceLiveBaseUrl,
            workspaceReentryArbiter: this.#reentry,
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
        this.#interaction = new McpEndpointHandlerInteraction(controlOptions);
        this.#todo = new McpEndpointHandlerTodo(controlOptions);
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
            await this.restoreTmuxWaits(this.#instanceName);
            const environment = await this.#environment.call(
                toolName,
                input,
                requestContext,
                selected !== undefined,
                signal
            );
            const workspaceApp = snapshot.exposed.some((entry) =>
                entry.owner === "workspace" && entry.definition.name === "workspace_open"
            );
            if (!workspaceApp) return environment;
            return await this.#interaction.bootstrapWorkspace(
                requireEnvironmentContextId(environment),
                environment,
            );
        }

        if (selected === undefined) {
            throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }

        const appOnlyInteraction = selected.owner === "workspace" && isAppOnlyInteractionTool(toolName);
        const resolvedContext = await this.#contextSelector.resolve(
            this.#contextRegistry,
            input,
            requestContext,
            this.#instanceName,
            { touch: !isPassiveWorkspaceRead(toolName) },
        );
        input = resolvedContext.input;
        const routed = selected.owner === "worker" || selected.owner === "artifact"
            ? readMcpRoutedInput(input, snapshot.instanceRoutingEnabled, this.#instanceName)
            : { input, instance: this.#instanceName };
        await this.restoreTmuxWaits(this.#instanceName);
        const context = await this.#createToolContext(
            toolName,
            resolvedContext.record,
            requestContext,
            routed.instance,
            selected.owner === "worker",
            !appOnlyInteraction,
            signal
        );
        const goalActivity = !appOnlyInteraction && context.ctxId !== undefined && toolName !== "workspace_goal"
            ? workspaceGoalActivity(toolName, routed.input, this.#tmuxBlockSyncMs)
            : undefined;
        let executionEpoch: number | undefined;
        if (!appOnlyInteraction && context.ctxId !== undefined) {
            executionEpoch = await this.#reentry.observeExecutionStart(context.ctxId);
            if (goalActivity !== undefined) {
                await this.#contextRegistry.observeAutomaticReentryActivity(context.ctxId, this.#instanceName, goalActivity).catch(() => undefined);
                await this.#gateway?.touchGoal?.(this.#instanceName, context.ctxId, goalActivity);
            }
        }

        const touchGoalAfter = goalActivity !== undefined && context.ctxId !== undefined;
        try {
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

            if (toolName === "tmux_run" && isMcpTmuxWaitGateway(this.#gateway) && readTmuxBlock(routed.input)) {
                this.#catalog.assertAdaptable(selected.definition);
                const ownerWorkspace = contextEnvironment(resolvedContext.record, this.#instanceName)?.workspace;
                return await this.#callTmuxRun(
                    routed.input,
                    context,
                    routed.instance,
                    ownerWorkspace,
                    signal,
                    executionEpoch,
                );
            }

            if (
                toolName === "tmux_read" && isMcpTmuxWaitGateway(this.#gateway) &&
                readTmuxReadTimeMs(routed.input) >= this.#tmuxBlockSyncMs
            ) {
                this.#catalog.assertAdaptable(selected.definition);
                const ownerWorkspace = contextEnvironment(resolvedContext.record, this.#instanceName)?.workspace;
                return await this.#callTmuxRead(
                    routed.input,
                    context,
                    routed.instance,
                    ownerWorkspace,
                    signal,
                    executionEpoch,
                );
            }

            return await this.#workerHandler.call(
                toolName,
                input,
                context,
                selected.definition,
                snapshot.instanceRoutingEnabled,
                signal,
                async (result, callId) => {
                    if (toolName === "tmux_read" && context.ctxId !== undefined) {
                        await this.#supersedeObservedTmuxWaits(
                            routed.instance,
                            readTmuxReadTask(routed.input),
                            context.ctxId,
                            result,
                            false,
                        );
                    }
                    return await this.#attachComments(toolName, result, context, callId, routed.instance);
                }
            );
        } finally {
            if (!appOnlyInteraction && context.ctxId !== undefined && signal?.aborted !== true) {
                await this.#reentry.observeExecutionActivity(context.ctxId);
            }
            if (touchGoalAfter) {
                await this.#gateway?.touchGoal?.(this.#instanceName, context.ctxId!, goalActivity).catch(() => undefined);
            }
        }
    }

    async #callTmuxRead(
        input: JsonValue,
        context: ToolCallContext,
        instance: string,
        ownerWorkspace: string | undefined,
        signal?: AbortSignal,
        executionEpoch?: number,
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway) || context.ctxId === undefined) {
            throw new Error("tmux_read durable wait state is unavailable.");
        }
        const task = readTmuxReadTask(input);
        const startedAt = Date.now();
        const invocationInput = { consumeOutput: false, line: 0, task, timeMs: 0 } as JsonValue;
        const transformResult = async (observed: JsonValue, callId: string) => await this.#finishTmuxRead(
            input,
            context,
            callId,
            instance,
            ownerWorkspace,
            observed,
            startedAt,
            signal,
            executionEpoch,
        );
        return instance === this.#instanceName
            ? await this.#worker.callTool("tmux_read", input, context, signal, transformResult, invocationInput)
            : await gateway.callTool(instance, "tmux_read", input, context, signal, transformResult, invocationInput);
    }

    async #finishTmuxRead(
        input: JsonValue,
        context: ToolCallContext,
        callId: string,
        instance: string,
        ownerWorkspace: string | undefined,
        observedValue: JsonValue,
        startedAt: number,
        signal?: AbortSignal,
        executionEpoch?: number,
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway) || context.ctxId === undefined) {
            throw new Error("tmux_read durable wait state is unavailable.");
        }
        const task = readTmuxReadTask(input);
        const timeout = readTmuxReadTimeMs(input);
        const line = readTmuxLine(input);
        if (!isRecord(observedValue)) throw new Error(`tmux_read returned an invalid observation for task ${task}.`);
        const observed = observedValue;
        if (tmuxReadReady(observed)) {
            const completed = await this.#consumeTmuxRead(instance, task, line, context, signal);
            await this.#supersedeObservedTmuxWaits(instance, task, context.ctxId, completed, false);
            return await this.#attachComments("tmux_read", completed, context, callId, instance);
        }

        await this.#supersedeObservedTmuxWaits(instance, task, context.ctxId, observed, true);

        const goal = await this.#currentGoal(this.#instanceName, context.ctxId);
        const taskAssociation = goal === undefined
            ? await this.#currentTaskAssociation(this.#instanceName, context.ctxId)
            : { kind: "none" as const };
        const goalStep = goal?.steps.find((step) => step.status === "active");
        const wait = await gateway.createWait(this.#instanceName, {
            automaticRecovery: taskAssociation.kind !== "ambiguous",
            createdByCtxId: context.ctxId,
            deadlineAt: new Date(startedAt + timeout).toISOString(),
            ...(goal === undefined ? {} : {
                goalId: goal.goalId,
                goalProgressAt: goal.lastProgressAt,
                ...(goal.progressEpoch === undefined ? {} : { goalProgressEpoch: goal.progressEpoch }),
                goalRevision: goal.revision,
            }),
            ...(goalStep === undefined ? {} : { goalStepId: goalStep.id }),
            kind: "tmux",
            ownerCallId: callId,
            payload: { line, operation: "read" },
            targetInstance: instance,
            targetId: task,
            ...(taskAssociation.kind !== "one" ? {} : {
                taskId: taskAssociation.taskId,
                taskRevision: taskAssociation.revision,
                todoItemId: taskAssociation.todoItemId,
            }),
            ...(ownerWorkspace === undefined ? {} : { workspace: ownerWorkspace }),
        });
        this.#ensureTmuxReadWaitTracker(
            this.#instanceName,
            wait.waitId,
            instance,
            task,
            context,
            callId,
            startedAt + timeout,
        );

        let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
        const boundary = new Promise<{ kind: "boundary" }>((resolve) => {
            boundaryTimer = setTimeout(() => resolve({ kind: "boundary" }), this.#tmuxBlockSyncMs);
        });
        const resolution = gateway.waitForWait(this.#instanceName, wait.waitId).then(
            (record) => ({ kind: "wait" as const, record }),
            (error: unknown) => ({ kind: "waitError" as const, error }),
        );

        let outcome: Awaited<typeof resolution> | { kind: "boundary" } | { kind: "transport" };
        try {
            outcome = await waitForMcpEndpointAbortable(Promise.race([resolution, boundary]), signal);
        } catch (error) {
            if (signal?.aborted !== true) throw error;
            outcome = { kind: "transport" };
        } finally {
            if (boundaryTimer !== undefined) clearTimeout(boundaryTimer);
        }

        let current = outcome.kind === "wait"
            ? outcome.record
            : (await gateway.listWaits(this.#instanceName)).find((entry) => entry.waitId === wait.waitId);
        if (outcome.kind === "transport") await this.#reentry.releaseExecutionActivity(context.ctxId, executionEpoch);
        if (
            (outcome.kind === "boundary" && current?.status === "waiting") ||
            (outcome.kind === "transport" && (
                current?.status === "waiting" ||
                (current?.status === "resolved" && current.detachedAt === undefined)
            ))
        ) {
            try {
                current = await gateway.detachWait(this.#instanceName, wait.waitId);
            } catch {
                current = (await gateway.listWaits(this.#instanceName)).find((entry) => entry.waitId === wait.waitId);
            }
        }
        if (current?.status === "detached" || (current?.status === "resolved" && current.detachedAt !== undefined)) {
            return await this.#attachComments(
                "tmux_read",
                { ...observed, detached: true },
                context,
                callId,
                instance,
            );
        }
        if (current?.status === "resolved") {
            await gateway.consumeWait(this.#instanceName, wait.waitId);
            const completed = await this.#consumeTmuxRead(instance, task, line, context);
            return await this.#attachComments("tmux_read", completed, context, callId, instance);
        }
        if (current?.status === "cancelled" && outcome.kind === "waitError") throw outcome.error;
        if (outcome.kind === "waitError") throw outcome.error;
        throw new Error(`tmux_read wait ${wait.waitId} entered an unexpected state.`);
    }

    async #callTmuxRun(
        input: JsonValue,
        context: ToolCallContext,
        instance: string,
        ownerWorkspace: string | undefined,
        signal?: AbortSignal,
        executionEpoch?: number,
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway) || context.ctxId === undefined) {
            throw new Error("tmux_run block wait state is unavailable.");
        }
        const startedAt = Date.now();
        const initialInput = {
            ...(isRecord(input) ? input : {}),
            consumeOutput: false,
            wait: "nonblock",
        } as JsonValue;
        const transformResult = async (started: JsonValue, callId: string) => await this.#finishTmuxRun(
            input,
            context,
            callId,
            instance,
            ownerWorkspace,
            started,
            startedAt,
            signal,
            executionEpoch,
        );
        return instance === this.#instanceName
            ? await this.#worker.callTool("tmux_run", input, context, signal, transformResult, initialInput)
            : await gateway.callTool(instance, "tmux_run", input, context, signal, transformResult, initialInput);
    }

    async #finishTmuxRun(
        input: JsonValue,
        context: ToolCallContext,
        callId: string,
        instance: string,
        ownerWorkspace: string | undefined,
        startedValue: JsonValue,
        startedAt: number,
        signal?: AbortSignal,
        executionEpoch?: number,
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway) || context.ctxId === undefined) {
            throw new Error("tmux_run block wait state is unavailable.");
        }
        const timeout = readTmuxTimeout(input);
        const line = readTmuxLine(input);
        const started = startedValue;
        if (!isRecord(started) || !isRecord(started.task) || typeof started.task.id !== "string") {
            throw new Error("tmux_run returned an invalid task result.");
        }
        if (started.task.status !== "running") {
            const completed = await this.#readTmuxTaskOutput(
                instance,
                started.task.id,
                line,
                context,
                signal,
            );
            return await this.#attachComments(
                "tmux_run",
                { ...started, ...completed },
                context,
                callId,
                instance,
            );
        }

        const task = started.task.id;
        const goal = await this.#currentGoal(this.#instanceName, context.ctxId);
        const taskAssociation = goal === undefined
            ? await this.#currentTaskAssociation(this.#instanceName, context.ctxId)
            : { kind: "none" as const };
        const goalStep = goal?.steps.find((step) => step.status === "active");
        const wait = await gateway.createWait(this.#instanceName, {
            automaticRecovery: taskAssociation.kind !== "ambiguous",
            createdByCtxId: context.ctxId,
            ...(timeout === undefined ? {} : { deadlineAt: new Date(startedAt + timeout).toISOString() }),
            ...(goal === undefined ? {} : {
                goalId: goal.goalId,
                goalProgressAt: goal.lastProgressAt,
                ...(goal.progressEpoch === undefined ? {} : { goalProgressEpoch: goal.progressEpoch }),
                goalRevision: goal.revision,
            }),
            ...(goalStep === undefined ? {} : { goalStepId: goalStep.id }),
            kind: "tmux",
            ownerCallId: callId,
            payload: { line },
            targetInstance: instance,
            targetId: task,
            ...(taskAssociation.kind !== "one" ? {} : {
                taskId: taskAssociation.taskId,
                taskRevision: taskAssociation.revision,
                todoItemId: taskAssociation.todoItemId,
            }),
            ...(ownerWorkspace === undefined ? {} : { workspace: ownerWorkspace }),
        });
        this.#ensureTmuxWaitTracker(
            this.#instanceName,
            wait.waitId,
            instance,
            task,
            context,
            callId,
            timeout === undefined ? undefined : startedAt + timeout,
        );

        let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
        const boundary = new Promise<{ kind: "boundary" }>((resolve) => {
            boundaryTimer = setTimeout(() => resolve({ kind: "boundary" }), this.#tmuxBlockSyncMs);
        });
        const resolution = gateway.waitForWait(this.#instanceName, wait.waitId).then(
            (record) => ({ kind: "wait" as const, record }),
            (error: unknown) => ({ kind: "waitError" as const, error }),
        );

        let outcome: Awaited<typeof resolution> | { kind: "boundary" } | { kind: "transport" };
        try {
            outcome = await waitForMcpEndpointAbortable(Promise.race([resolution, boundary]), signal);
        } catch (error) {
            if (signal?.aborted !== true) throw error;
            outcome = { kind: "transport" };
        } finally {
            if (boundaryTimer !== undefined) clearTimeout(boundaryTimer);
        }

        let current = outcome.kind === "wait"
            ? outcome.record
            : (await gateway.listWaits(this.#instanceName)).find((entry) => entry.waitId === wait.waitId);
        if (outcome.kind === "transport") await this.#reentry.releaseExecutionActivity(context.ctxId, executionEpoch);
        if (
            (outcome.kind === "boundary" && current?.status === "waiting") ||
            (outcome.kind === "transport" && (
                current?.status === "waiting" ||
                (current?.status === "resolved" && current.detachedAt === undefined)
            ))
        ) {
            try {
                current = await gateway.detachWait(this.#instanceName, wait.waitId);
            } catch {
                current = (await gateway.listWaits(this.#instanceName)).find((entry) => entry.waitId === wait.waitId);
            }
        }
        if (current?.status === "detached" || (current?.status === "resolved" && current.detachedAt !== undefined)) {
            return await this.#attachComments(
                "tmux_run",
                { ...started, detached: true },
                context,
                callId,
                instance,
            );
        }
        if (current?.status === "resolved") {
            await gateway.consumeWait(this.#instanceName, wait.waitId);
            if (current.result === undefined || !isRecord(current.result)) {
                throw new Error("tmux_run wait resolved without a task result.");
            }
            if (isTmuxTaskRunning(current.result, task)) {
                return await this.#attachComments(
                    "tmux_run",
                    { ...started, ...current.result },
                    context,
                    callId,
                    instance,
                );
            }
            const completed = await this.#readTmuxTaskOutput(instance, task, line, context);
            return await this.#attachComments(
                "tmux_run",
                { ...started, ...current.result, ...completed },
                context,
                callId,
                instance,
            );
        }
        if (current?.status === "cancelled" && outcome.kind === "waitError") throw outcome.error;
        if (outcome.kind === "waitError") throw outcome.error;
        throw new Error(`tmux_run wait ${wait.waitId} entered an unexpected state.`);
    }

    async #currentGoal(instance: string, ctxId: string) {
        const gateway = this.#gateway;
        if (!isMcpGoalGateway(gateway)) return undefined;
        const goal = await gateway.readGoal(instance, ctxId);
        return goal !== undefined && (goal.status === "active" || goal.status === "blocked") ? goal : undefined;
    }

    async #currentTaskAssociation(instance: string, ctxId: string): Promise<
        | { kind: "none" }
        | { kind: "ambiguous" }
        | { kind: "one"; revision: number; taskId: string; todoItemId: string }
    > {
        const gateway = this.#gateway;
        if (gateway === undefined) return { kind: "none" };
        const todo = await gateway.readTodo(instance);
        if (typeof todo !== "object" || todo === null || Array.isArray(todo) || !Array.isArray(todo.tasks)) {
            return { kind: "none" };
        }
        const active = todo.tasks.filter((task) => (
            typeof task === "object" && task !== null && !Array.isArray(task) &&
            task.ctxId === ctxId && task.status === "in_progress" && typeof task.taskId === "string"
        ));
        if (active.length === 0) return { kind: "none" };
        if (active.length !== 1) return { kind: "ambiguous" };
        const task = active[0];
        if (typeof task !== "object" || task === null || Array.isArray(task) || typeof task.taskId !== "string") {
            return { kind: "none" };
        }
        const detail = await gateway.readTodo(instance, { taskId: task.taskId });
        if (typeof detail !== "object" || detail === null || Array.isArray(detail) || !Array.isArray(detail.items)) {
            return { kind: "ambiguous" };
        }
        const current = detail.items.filter((item) => (
            typeof item === "object" && item !== null && !Array.isArray(item) &&
            item.status === "in_progress" && typeof item.id === "string"
        ));
        if (current.length !== 1 || typeof detail.revision !== "number") return { kind: "ambiguous" };
        return {
            kind: "one",
            revision: detail.revision,
            taskId: task.taskId,
            todoItemId: (current[0] as { id: string }).id,
        };
    }

    #ensureTmuxWaitTracker(
        waitInstance: string,
        waitId: string,
        targetInstance: string,
        taskId: string,
        context: ToolCallContext,
        ownerCallId?: string,
        deadlineAt?: number,
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway)) {
            throw new Error("tmux_run block wait state is unavailable.");
        }
        const key = `${waitInstance}:${waitId}`;
        const existing = this.#tmuxWaitTrackers.get(key);
        if (existing !== undefined) return existing.promise;
        const controller = new AbortController();
        const tracker = this.#trackTmuxTask(gateway, targetInstance, taskId, context, controller.signal, deadlineAt).then(async (result) => {
            const consumeIfDetached = await this.#contextExecutionActive(context.ctxId, ownerCallId);
            await gateway.resolveWait(waitInstance, waitId, result, { consumeIfDetached });
            return result;
        }, async (error: unknown) => {
            if (!controller.signal.aborted) {
                await gateway.cancelWait(waitInstance, waitId).catch(() => undefined);
            }
            throw error;
        }).finally(() => {
            this.#tmuxWaitTrackers.delete(key);
        });
        this.#tmuxWaitTrackers.set(key, { controller, promise: tracker });
        void tracker.catch(() => undefined);
        return tracker;
    }

    #ensureTmuxReadWaitTracker(
        waitInstance: string,
        waitId: string,
        targetInstance: string,
        taskId: string,
        context: ToolCallContext,
        ownerCallId: string | undefined,
        deadlineAt: number,
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway)) {
            throw new Error("tmux_read durable wait state is unavailable.");
        }
        const key = `${waitInstance}:${waitId}`;
        const existing = this.#tmuxWaitTrackers.get(key);
        if (existing !== undefined) return existing.promise;
        const controller = new AbortController();
        const tracker = this.#trackTmuxReadReady(
            gateway,
            targetInstance,
            taskId,
            context,
            controller.signal,
            deadlineAt,
        ).then(async (result) => {
            const consumeIfDetached = await this.#contextExecutionActive(context.ctxId, ownerCallId);
            await gateway.resolveWait(waitInstance, waitId, result, { consumeIfDetached });
            return result;
        }, async (error: unknown) => {
            if (!controller.signal.aborted) {
                await gateway.cancelWait(waitInstance, waitId).catch(() => undefined);
            }
            throw error;
        }).finally(() => {
            this.#tmuxWaitTrackers.delete(key);
        });
        this.#tmuxWaitTrackers.set(key, { controller, promise: tracker });
        void tracker.catch(() => undefined);
        return tracker;
    }

    async restoreTmuxWaits(instance: string = this.#instanceName): Promise<void> {
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
                const payload = isRecord(wait.payload) ? wait.payload : undefined;
                if (payload?.operation === "read" && wait.deadlineAt !== undefined) {
                    this.#ensureTmuxReadWaitTracker(
                        instance,
                        wait.waitId,
                        wait.targetInstance ?? instance,
                        wait.targetId,
                        { ctxId: wait.createdByCtxId, source: "mcp" },
                        wait.ownerCallId,
                        Date.parse(wait.deadlineAt),
                    );
                } else {
                    this.#ensureTmuxWaitTracker(
                        instance,
                        wait.waitId,
                        wait.targetInstance ?? instance,
                        wait.targetId,
                        { ctxId: wait.createdByCtxId, source: "mcp" },
                        wait.ownerCallId,
                        wait.deadlineAt === undefined ? undefined : Date.parse(wait.deadlineAt),
                    );
                }
            }
        })();
        this.#tmuxWaitRestores.set(instance, restore);
        try {
            await restore;
        } catch {
            // Restoration is opportunistic and must not fail unrelated tool calls.
        } finally {
            if (this.#tmuxWaitRestores.get(instance) === restore) {
                this.#tmuxWaitRestores.delete(instance);
            }
        }
    }

    async #contextExecutionActive(ctxId: string | undefined, ownerCallId?: string): Promise<boolean> {
        return ctxId === undefined ? false : await this.#reentry.executionActive(ctxId, ownerCallId);
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

    async #trackTmuxReadReady(
        gateway: McpTmuxWaitGateway,
        instance: string,
        taskId: string,
        context: ToolCallContext,
        signal: AbortSignal,
        deadlineAt: number,
    ): Promise<JsonValue> {
        while (true) {
            throwIfMcpEndpointAborted(signal);
            const remaining = Math.max(0, deadlineAt - Date.now());
            try {
                const result = await this.#observeTmuxRead(
                    instance,
                    taskId,
                    context,
                    Math.min(this.#tmuxWaitPollMs, remaining),
                    signal,
                );
                if (tmuxReadReady(result) || Date.now() >= deadlineAt) return result;
            } catch (error) {
                if (!isRetryableTmuxObservationError(error)) throw error;
                if (Date.now() >= deadlineAt) throw error;
                await waitForMcpEndpointAbortable(
                    new Promise<void>((resolve) => setTimeout(
                        resolve,
                        Math.min(this.#tmuxWaitPollMs, Math.max(1, deadlineAt - Date.now())),
                    )),
                    signal,
                );
            }
        }
    }

    async #observeTmuxRead(
        instance: string,
        taskId: string,
        context: ToolCallContext,
        timeMs: number,
        signal?: AbortSignal,
    ): Promise<Record<string, JsonValue>> {
        const input = { consumeOutput: false, line: 0, task: taskId, timeMs };
        const result = await this.#invokeToolInternal(instance, "tmux_read", input, context, signal);
        if (!isRecord(result)) throw new Error(`tmux_read returned an invalid observation for task ${taskId}.`);
        return result;
    }

    async #consumeTmuxRead(
        instance: string,
        taskId: string,
        line: number,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<Record<string, JsonValue>> {
        const input = { line, task: taskId, timeMs: 0 };
        const result = await this.#invokeToolInternal(instance, "tmux_read", input, context, signal);
        if (!isRecord(result)) throw new Error(`tmux_read returned an invalid result for task ${taskId}.`);
        return result;
    }

    async #supersedeObservedTmuxWaits(
        targetInstance: string,
        taskId: string,
        ctxId: string,
        observation: JsonValue,
        replacePending: boolean,
    ): Promise<void> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway) || !isRecord(observation)) return;
        const running = isTmuxTaskRunning(observation, taskId);
        const now = Date.now();
        const waits = await gateway.listWaits(this.#instanceName);
        for (const wait of waits) {
            if (
                wait.kind !== "tmux" || wait.createdByCtxId !== ctxId || wait.targetId !== taskId ||
                (wait.targetInstance ?? this.#instanceName) !== targetInstance
            ) continue;
            if (wait.status === "resolved" && wait.detachedAt !== undefined) {
                await gateway.consumeWait(this.#instanceName, wait.waitId).catch(() => undefined);
                continue;
            }
            if (wait.status !== "detached") continue;
            const deadline = wait.deadlineAt === undefined ? Number.NaN : Date.parse(wait.deadlineAt);
            const triggerAlreadyObserved = Number.isFinite(deadline) && deadline <= now;
            if (!replacePending && running && !triggerAlreadyObserved) continue;
            await gateway.cancelWait(this.#instanceName, wait.waitId).catch(() => undefined);
            this.#interruptTmuxWaitTracker(this.#instanceName, wait.waitId);
        }
    }

    async #readTmuxTaskOutput(
        instance: string,
        taskId: string,
        line: number,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<Record<string, JsonValue>> {
        const input = { line, task: taskId };
        const result = await this.#invokeToolInternal(instance, "tmux_read", input, context, signal);
        if (!isRecord(result)) {
            throw new Error(`tmux_read returned an invalid result for task ${taskId}.`);
        }
        return result;
    }

    async #invokeToolInternal(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        if (instance === this.#instanceName) {
            if (this.#worker.invokeToolInternal === undefined) {
                throw new Error(`Internal worker invocation is unavailable for ${instance}.`);
            }
            return await this.#worker.invokeToolInternal(toolName, input, context, signal);
        }
        const gateway = this.#gateway;
        if (gateway === undefined) throw new Error(`Instance gateway is unavailable for ${instance}.`);
        if (gateway.invokeToolInternal === undefined) {
            throw new Error(`Internal worker invocation is unavailable for ${instance}.`);
        }
        return await gateway.invokeToolInternal(instance, toolName, input, context, signal);
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

function requireEnvironmentContextId(result: JsonValue): string {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error("environ_info returned an invalid structured result.");
    }
    const ctxId = result.ctxId;
    if (typeof ctxId !== "string" || ctxId.length === 0) {
        throw new Error("environ_info result is missing ctxId.");
    }
    return ctxId;
}

function isAppOnlyInteractionTool(toolName: string): boolean {
    return toolName === "workspace_reconnect" ||
        toolName === "workspace_snapshot" ||
        toolName === "workspace_watch" ||
        toolName === "workspace_reentry_control" ||
        toolName === "workspace_goal_pause" ||
        toolName === "workspace_goal_resume" ||
        toolName === "workspace_goal_stop" ||
        toolName === "workspace_question_answer" ||
        toolName === "workspace_wait_interrupt" ||
        toolName === "workspace_task_control" ||
        toolName === "workspace_wait_recover" ||
        toolName === "workspace_approval_decide";
}

function isPassiveWorkspaceRead(toolName: string): boolean {
    return toolName === "workspace_reconnect" ||
        toolName === "workspace_snapshot" ||
        toolName === "workspace_watch";
}

const OBSERVATION_TOOLS = new Set([
    "artifact_read",
    "artifact_share",
    "artifact_viewImage",
    "file_find",
    "file_info",
    "file_read",
    "file_search",
    "instance_list",
    "instance_status",
    "tmux_inspect",
    "tmux_list",
    "todo_read",
    "workspace_open",
]);

const MUTATION_TOOLS = new Set([
    "artifact_transfer",
    "file_edit",
    "todo_write",
]);

function workspaceGoalActivity(toolName: string, input: JsonValue, tmuxBlockSyncMs: number): GoalActivityKind {
    if (toolName === "workspace_ask") return "wait";
    if (toolName === "tmux_run") return readTmuxBlock(input) ? "wait" : "execution";
    if (toolName === "tmux_read") return readTmuxReadTimeMs(input) >= tmuxBlockSyncMs ? "wait" : "observation";
    if (OBSERVATION_TOOLS.has(toolName)) return "observation";
    if (MUTATION_TOOLS.has(toolName)) return "mutation";
    return "execution";
}

function readTmuxBlock(input: JsonValue): boolean {
    return isRecord(input) && input.wait === "block";
}

function readTmuxTimeout(input: JsonValue): number | undefined {
    if (!isRecord(input) || input.timeout === undefined) return undefined;
    if (typeof input.timeout !== "number" || !Number.isInteger(input.timeout) || input.timeout < 1) {
        throw new Error("tmux_run timeout must be a positive integer in milliseconds.");
    }
    return input.timeout;
}

function readTmuxReadTask(input: JsonValue): string {
    if (!isRecord(input) || typeof input.task !== "string" || input.task.trim().length === 0) {
        throw new Error("tmux_read task must be a non-empty string.");
    }
    return input.task.trim();
}

function readTmuxReadTimeMs(input: JsonValue): number {
    if (!isRecord(input) || input.timeMs === undefined) return 0;
    if (
        typeof input.timeMs !== "number" || !Number.isInteger(input.timeMs) ||
        input.timeMs < 0 || input.timeMs > 3_600_000
    ) {
        throw new Error("tmux_read timeMs must be an integer between 0 and 3600000.");
    }
    return input.timeMs;
}

function readTmuxLine(input: JsonValue): number {
    if (!isRecord(input) || input.line === undefined) return 80;
    if (
        typeof input.line !== "number" ||
        !Number.isInteger(input.line) ||
        input.line < -400 ||
        input.line > 400
    ) {
        throw new Error("tmux_run line must be an integer between -400 and 400.");
    }
    return input.line;
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

function tmuxReadReady(result: JsonValue): boolean {
    if (!isRecord(result)) return false;
    return result.waitReason === "output" || result.waitReason === "terminal";
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
