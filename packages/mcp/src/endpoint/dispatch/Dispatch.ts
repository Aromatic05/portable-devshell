import type { ToolCallHookValue } from "@portable-devshell/core";
import {
    runtimeErrorCodes,
    toRemoteErrorBody,
    type GoalActivityKind,
    type JsonValue,
    type McpContextEnvironment,
    type McpContextRecord,
    type ToolCallContext,
    type ToolCallProvenance,
} from "@portable-devshell/shared";

import type { ContextRegistryPort } from "@portable-devshell/shared";
import type { ContextEnvironmentPort, ContextCleanupPort } from "../../context/Port.js";
import {
    createMcpContextSelector,
    readMcpContextInput,
    type McpContextSelector,
} from "../../context/Selector.js";
import {
    isMcpGoalGateway,
    isMcpTmuxWaitGateway,
    type McpInstanceGateway,
    type McpTmuxWaitGateway,
} from "../../instance/Gateway.js";
import type { McpToolCatalogArtifactName } from "../domain/artifact/Catalog.js";
import { mcpEnvironmentToolName } from "../domain/context/environment/Catalog.js";
import type { McpToolCatalogWorkspaceName } from "../workspace/Catalog.js";
import type { McpToolCatalogTodoName } from "../domain/task/Catalog.js";
import type { WorkspaceAppLeaseStore } from "../../workspace/app/Lease.js";
import type { WorkspaceAppPresenceStore } from "../../workspace/app/Presence.js";
import type { WorkspaceActionStore } from "../../workspace/ActionStore.js";
import { readCurrentTaskAssociation } from "../../workspace/contributor/Task.js";
import { McpWorkspaceReentryArbiter } from "../../workspace/reentry/Arbiter.js";
import {
    throwIfMcpEndpointAborted,
    waitForMcpEndpointAbortable,
    waitForMcpGatewayReady,
    requireMcpEndpointGateway,
} from "../call/Boundary.js";
import {
    mcpLegacyToolTombstone,
    resolveMcpLegacyTool,
} from "../tool/Compatibility.js";
import type { McpEndpointCatalog } from "../tool/Catalog.js";
import { mcpToolActivity } from "../tool/Metadata.js";
import {
    readMcpProvenanceInput,
    readMcpRoutedInput,
} from "../tool/Input.js";
import type { McpEndpointCallContext, McpEndpointWorkerPort } from "../call/Port.js";
import { McpNativeToolResult, type McpEndpointResult } from "../call/Boundary.js";
import type { McpToolProvenanceRecorder } from "../tool/Provenance.js";
import { McpEndpointHandlerArtifact } from "../domain/artifact/Handler.js";
import { McpEndpointHandlerEnvironment } from "../domain/context/environment/Handler.js";
import { McpEndpointHandlerWorkspace } from "../workspace/Handler.js";
import { McpEndpointHandlerTodo } from "../domain/task/Handler.js";
import { McpEndpointHandlerTool } from "../tool/Handler.js";
import {
    callMcpEndpointToolOperation,
    assertMcpEndpointReady,
    mcpEndpointToolNotExposed,
} from "../call/Boundary.js";

export type {
    McpEndpointCallContext,
    McpEndpointWorkerPort,
} from "../call/Port.js";
export type { McpEndpointEnvironmentHandshake } from "../../instance/Gateway.js";

export interface McpEndpointDispatchOptions {
    catalog: McpEndpointCatalog;
    cleanup: ContextCleanupPort;
    contextRegistry: ContextRegistryPort;
    environmentService: ContextEnvironmentPort;
    contextSelector?: McpContextSelector;
    gateway?: McpInstanceGateway;
    instanceName: string;
    readyWaitMs?: number;
    tmuxBlockSyncMs?: number;
    tmuxWaitPollMs?: number;
    toolProvenance?: McpToolProvenanceRecorder;
    worker: McpEndpointWorkerPort;
    workspaceAppLeases?: WorkspaceAppLeaseStore;
    workspaceAppPresence?: WorkspaceAppPresenceStore;
    workspaceActionStore?: WorkspaceActionStore;
    workspaceLiveBaseUrl?: string;
}

interface McpAcceptedCall {
    value: ToolCallHookValue;
    executionEpoch?: number;
    goalActivity?: GoalActivityKind;
    workspaceAdvice: string[];
}

const MCP_TMUX_WAIT_POLL_MS = 1_000;
// Keep one product-visible synchronous handoff window across all MCP context modes.
const MCP_TMUX_BLOCK_SYNC_MS = 3 * 60_000;

export function mcpTmuxBlockSyncMsForContextMode(
    _mode: McpContextSelector["id"],
): number {
    return MCP_TMUX_BLOCK_SYNC_MS;
}

export class McpEndpointDispatch {
    readonly #artifact: McpEndpointHandlerArtifact;
    readonly #catalog: McpEndpointCatalog;
    readonly #contextRegistry: ContextRegistryPort;
    readonly #environmentService: ContextEnvironmentPort;
    readonly #contextSelector: McpContextSelector;
    readonly #environment: McpEndpointHandlerEnvironment;
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #workspace: McpEndpointHandlerWorkspace;
    readonly #reentry: McpWorkspaceReentryArbiter;
    readonly #tmuxBlockSyncMs: number;
    readonly #readyWaitMs?: number;
    readonly #tmuxWaitPollMs: number;
    readonly #tmuxWaitRestores = new Map<string, Promise<void>>();
    readonly #tmuxWaitTrackers = new Map<
        string,
        { controller: AbortController; promise: Promise<JsonValue> }
    >();
    readonly #todo: McpEndpointHandlerTodo;
    readonly #toolProvenance?: McpToolProvenanceRecorder;
    readonly #worker: McpEndpointWorkerPort;
    readonly #workerHandler: McpEndpointHandlerTool;

    constructor(options: McpEndpointDispatchOptions) {
        this.#catalog = options.catalog;
        this.#readyWaitMs = options.readyWaitMs;
        this.#contextRegistry = options.contextRegistry;
        this.#environmentService = options.environmentService;
        this.#contextSelector =
            options.contextSelector ?? createMcpContextSelector("explicit");
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#reentry = new McpWorkspaceReentryArbiter({
            contextRegistry: this.#contextRegistry,
            gateway: options.gateway,
            instanceName: options.instanceName,
        });
        this.#tmuxBlockSyncMs =
            options.tmuxBlockSyncMs ??
            mcpTmuxBlockSyncMsForContextMode(this.#contextSelector.id);
        this.#tmuxWaitPollMs = options.tmuxWaitPollMs ?? MCP_TMUX_WAIT_POLL_MS;
        this.#toolProvenance = options.toolProvenance;
        this.#worker = options.worker;
        const controlOptions = {
            contextRegistry: this.#contextRegistry,
            gateway: options.gateway,
            instanceName: options.instanceName,
            workspaceAppLeases: options.workspaceAppLeases,
            workspaceAppPresence: options.workspaceAppPresence,
            workspaceActionStore: options.workspaceActionStore,
            workspaceLiveBaseUrl: options.workspaceLiveBaseUrl,
            workspaceReentryArbiter: this.#reentry,
            onWaitInterrupted: (waitId: string) => this.#interruptTmuxWaitTracker(this.#instanceName, waitId),
        };
        this.#artifact = new McpEndpointHandlerArtifact(controlOptions);
        this.#environment = new McpEndpointHandlerEnvironment({
            cleanup: options.cleanup,
            contextRegistry: this.#contextRegistry,
            contextSelector: this.#contextSelector,
            environment: options.environmentService,
            gateway: options.gateway,
            instanceName: options.instanceName,
            worker: options.worker,
        });
        this.#workspace = new McpEndpointHandlerWorkspace(controlOptions);
        this.#todo = new McpEndpointHandlerTodo(controlOptions);
        this.#workerHandler = new McpEndpointHandlerTool({
            gateway: options.gateway,
            instanceName: options.instanceName,
        });
    }

    assertReady(
        worker: Pick<McpEndpointWorkerPort, "snapshot"> = this.#worker,
        instanceName: string = this.#instanceName,
    ): void {
        assertMcpEndpointReady(worker, instanceName);
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        throwIfMcpEndpointAborted(signal);
        const requestedToolName = toolName;
        const compatibility = resolveMcpLegacyTool(toolName);
        if (compatibility?.kind === "tombstone") {
            return mcpLegacyToolTombstone(toolName, compatibility);
        }
        const legacyWorkspaceAppTool =
            compatibility?.kind === "workspace-app-v0615"
                ? requestedToolName
                : undefined;
        if (
            compatibility?.kind === "alias" ||
            compatibility?.kind === "workspace-app-v0615"
        ) {
            toolName = compatibility.replacement;
        }
        const snapshot = this.#catalog.snapshot();
        const known = snapshot.merged.find(
            (entry) => entry.definition.name === toolName,
        );
        const selected = snapshot.exposed.find(
            (entry) => entry.definition.name === toolName,
        );

        if (known?.owner === "environment") {
            await this.restoreTmuxWaits(this.#instanceName);
            const environment = await this.#environment.call(
                toolName,
                input,
                requestContext,
                selected !== undefined,
                signal,
            );
            const workspaceApp = snapshot.exposed.some(
                (entry) =>
                    entry.owner === "workspace" &&
                    entry.definition.name === "workspace_open",
            );
            if (!workspaceApp || toolName !== mcpEnvironmentToolName)
                return environment.structuredContent;
            return await this.#workspace.bootstrapWorkspace(
                environment.ctxId,
                environment.structuredContent,
            );
        }

        if (selected === undefined) {
            throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }

        const appOnlyInteraction =
            selected.owner === "workspace" &&
            isAppOnlyInteractionTool(toolName);
        const provenanceInput = readMcpProvenanceInput(input);
        input = provenanceInput.input;
        const touchContext = !isPassiveWorkspaceRead(toolName);
        const resolvedContext = appOnlyInteraction
            ? await this.#resolveAppOnlyContext(
                  input,
                  requestContext,
                  !isPassiveWorkspaceRead(toolName),
              )
            : await this.#contextSelector.resolve(
                  this.#contextRegistry,
                  input,
                  requestContext,
                  this.#instanceName,
                  {
                      allowExpired:
                          touchContext &&
                          !this.#contextSelector.requiresExplicitContextId,
                      touch: false,
                  },
              );
        input = resolvedContext.input;
        const routed =
            selected.owner === "worker" || selected.owner === "artifact"
                ? readMcpRoutedInput(
                      input,
                      snapshot.instanceRoutingEnabled,
                      this.#instanceName,
                  )
                : { input, instance: this.#instanceName };
        const context = this.#createToolContext(
            resolvedContext.record,
            requestContext,
            routed.instance,
            signal,
        );
        let accepted: McpAcceptedCall | undefined;
        const prepareCall = async (
            callId: string,
            finalValue: ToolCallHookValue,
        ): Promise<McpAcceptedCall> => {
            accepted = await this.#prepareCall(
                callId, finalValue, selected.owner, requestContext,
                provenanceInput.provenance, signal,
            );
            return accepted;
        };
        try {
            if (appOnlyInteraction) {
                this.#catalog.assertAdaptable(selected.definition);
                const result =
                    legacyWorkspaceAppTool === undefined
                        ? await this.#workspace.call(
                              toolName as McpToolCatalogWorkspaceName,
                              input,
                              context,
                              context.requestId ?? "workspace-app",
                              signal,
                          )
                        : await this.#workspace.callLegacyV0615(
                              legacyWorkspaceAppTool,
                              input,
                              context,
                          );
                return result;
            }

            if (
                selected.owner === "todo" ||
                selected.owner === "artifact" ||
                selected.owner === "extension" ||
                selected.owner === "workspace"
            ) {
                const owner = selected.owner;
                this.#catalog.assertAdaptable(selected.definition);
                return await this.#auditControlTool(
                    owner,
                    toolName,
                    input,
                    context,
                    routed.instance,
                    prepareCall,
                    signal,
                );
            }

            if (
                toolName === "tmux_run" &&
                isMcpTmuxWaitGateway(this.#gateway) &&
                readTmuxBlock(routed.input)
            ) {
                this.#catalog.assertAdaptable(selected.definition);
                return appendWorkspaceAdvice(
                    await this.#callTmuxWait(
                        "run",
                        routed.input,
                        context,
                        routed.instance,
                        prepareCall,
                        signal,
                    ),
                    accepted?.workspaceAdvice ?? [],
                );
            }

            if (
                toolName === "tmux_read" &&
                isMcpTmuxWaitGateway(this.#gateway) &&
                readTmuxReadTimeMs(routed.input) >= this.#tmuxBlockSyncMs
            ) {
                this.#catalog.assertAdaptable(selected.definition);
                return appendWorkspaceAdvice(
                    await this.#callTmuxWait(
                        "read",
                        routed.input,
                        context,
                        routed.instance,
                        prepareCall,
                        signal,
                    ),
                    accepted?.workspaceAdvice ?? [],
                );
            }

            return appendWorkspaceAdvice(
                await this.#workerHandler.call(
                    toolName,
                    input,
                    context,
                    snapshot.instanceRoutingEnabled,
                    signal,
                    async (result) => {
                        if (
                            accepted?.value.toolName === "tmux_read" &&
                            accepted.value.context.ctxId !== undefined
                        ) {
                            await this.#supersedeObservedTmuxWaits(
                                accepted.value.context.instance,
                                readTmuxReadTask(accepted.value.payload),
                                accepted.value.context.ctxId,
                                result,
                                false,
                            );
                        }
                        return result;
                    },
                    async (rewrittenInput, callId, value) => {
                        await prepareCall(callId, value);
                        return rewrittenInput;
                    },
                ),
                accepted?.workspaceAdvice ?? [],
            );
        } finally {
            const finalContext = accepted?.value.context;
            if (finalContext?.ctxId !== undefined && signal?.aborted !== true) {
                await this.#reentry.observeExecutionActivity(finalContext.ctxId, finalContext.instance);
            }
            if (finalContext?.ctxId !== undefined && accepted?.goalActivity !== undefined) {
                await this.#gateway?.touchGoal?.(
                    finalContext.instance, finalContext.ctxId, accepted.goalActivity,
                ).catch(() => undefined);
            }
        }
    }

    async #prepareCall(
        callId: string,
        value: ToolCallHookValue,
        owner: string,
        requestContext: McpEndpointCallContext,
        provenance: ToolCallProvenance,
        signal?: AbortSignal,
    ): Promise<McpAcceptedCall> {
        const { instance, ctxId } = value.context;
        const gateway = requireMcpEndpointGateway(this.#gateway, this.#instanceName);
        const touchContext = !isPassiveWorkspaceRead(value.toolName);
        let record = await this.#contextRegistry.lookup(ctxId!, {
            principal: requestContext.principal,
        });
        if (touchContext) {
            record = record.status === "expired"
                ? await this.#contextRegistry.renewForPrincipal(record.ctxId, { principal: requestContext.principal })
                : await this.#contextRegistry.validateAndTouch(record.ctxId, { principal: requestContext.principal });
        } else {
            record = await this.#contextRegistry.validate(record.ctxId, { principal: requestContext.principal });
        }
        await this.#contextRegistry.assertInstanceAvailable(record.ctxId, instance);
        let workspaceAdvice: string[] = [];
        if (owner === "worker") {
            await waitForMcpGatewayReady(gateway, instance, signal, { timeoutMs: this.#readyWaitMs });
            const definition = gateway.listTools(instance).find((tool) => tool.name === value.toolName);
            if (definition === undefined) throw mcpEndpointToolNotExposed(value.toolName, instance);
            this.#catalog.assertAdaptable(definition);
            const prepared = await this.#environmentService.ensurePrepared(
                record.ctxId,
                instance,
                value.context.workspace,
            );
            const alerts = await this.#touchAlerts(instance, prepared.workspace!);
            workspaceAdvice = alerts.advice.map((advice) => advice.text);
        }
        await this.restoreTmuxWaits(instance);
        await this.#appendMcpToolCalled(instance, value.toolName, value.context);
        const executionEpoch = await this.#reentry.observeExecutionStart(record.ctxId, instance);
        const definition = owner === "worker"
            ? gateway.listTools(instance).find((tool) => tool.name === value.toolName)
            : this.#catalog.getTool(value.toolName);
        const goalActivity = value.toolName === "workspace_goal" ? undefined
            : workspaceGoalActivity(value.toolName, value.payload, this.#tmuxBlockSyncMs, definition?._meta);
        if (goalActivity !== undefined) {
            await this.#contextRegistry.reentry.observeAutomaticReentryActivity(record.ctxId, instance, goalActivity).catch(() => undefined);
            await gateway.touchGoal?.(instance, record.ctxId, goalActivity);
        }
        if (hasToolProvenance(provenance) && this.#toolProvenance !== undefined) {
            await this.#toolProvenance.record({ callId, ...provenance, instance }).catch(() => undefined);
        }
        return { value, executionEpoch, goalActivity, workspaceAdvice };
    }

    async #callTmuxWait(
        mode: "read" | "run",
        input: JsonValue,
        context: ToolCallContext,
        instance: string,
        prepareCall: (callId: string, value: ToolCallHookValue) => Promise<McpAcceptedCall>,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway) || context.ctxId === undefined) {
            throw new Error(
                mode === "read"
                    ? "tmux_read durable wait state is unavailable."
                    : "tmux_run block wait state is unavailable.",
            );
        }
        const startedAt = Date.now();
        let finalValue: ToolCallHookValue;
        let executionEpoch: number | undefined;
        const invocationInput = async (rewrittenInput: JsonValue, callId: string, value: ToolCallHookValue): Promise<JsonValue> => {
            const prepared = await prepareCall(callId, value);
            finalValue = value;
            executionEpoch = prepared.executionEpoch;
            return mode === "read"
                ? {
                      consumeOutput: false,
                      line: 0,
                      task: readTmuxReadTask(rewrittenInput),
                      timeMs: 0,
                  }
                : {
                      ...(isRecord(rewrittenInput) ? rewrittenInput : {}),
                      consumeOutput: false,
                      wait: "nonblock",
                  };
        };
        const transformResult = async (observed: JsonValue, callId: string) => {
            const value = finalValue;
            return mode === "read"
                ? await this.#finishTmuxRead(
                      value.payload,
                      value.context,
                      callId,
                      value.context.instance,
                      value.context.workspace,
                      observed,
                      startedAt,
                      signal,
                      executionEpoch,
                  )
                : await this.#finishTmuxRun(
                      value.payload,
                      value.context,
                      callId,
                      value.context.instance,
                      value.context.workspace,
                      observed,
                      startedAt,
                      signal,
                      executionEpoch,
                  );
        };
        return await gateway.callTool(
            instance,
            mode === "read" ? "tmux_read" : "tmux_run",
            input,
            context,
            signal,
            transformResult,
            invocationInput,
        );
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
        if (!isRecord(observedValue))
            throw new Error(
                `tmux_read returned an invalid observation for task ${task}.`,
            );
        const observed = observedValue;
        if (tmuxReadReady(observed, line)) {
            const completed = await this.#invokeTmuxRead(
                instance,
                task,
                context,
                { line, timeMs: 0 },
                "result",
                signal,
            );
            await this.#supersedeObservedTmuxWaits(
                instance,
                task,
                context.ctxId,
                completed,
                false,
            );
            return completed;
        }

        await this.#supersedeObservedTmuxWaits(
            instance,
            task,
            context.ctxId,
            observed,
            true,
        );

        const goal = await this.#currentGoal(this.#instanceName, context.ctxId);
        const taskAssociation =
            goal === undefined
                ? await readCurrentTaskAssociation(
                      gateway,
                      this.#instanceName,
                      context.ctxId,
                  )
                : { kind: "none" as const };
        const goalStep = goal?.steps.find((step) => step.status === "active");
        const wait = await gateway.createWait(this.#instanceName, {
            automaticRecovery:
                this.#catalog.getExposed("workspace_open") !== undefined &&
                taskAssociation.kind !== "ambiguous",
            createdByCtxId: context.ctxId,
            deadlineAt: new Date(startedAt + timeout).toISOString(),
            ...(goal === undefined
                ? {}
                : {
                      goalId: goal.goalId,
                      goalProgressAt: goal.lastProgressAt,
                      ...(goal.progressEpoch === undefined
                          ? {}
                          : { goalProgressEpoch: goal.progressEpoch }),
                      goalRevision: goal.revision,
                  }),
            ...(goalStep === undefined ? {} : { goalStepId: goalStep.id }),
            kind: "tmux",
            ownerCallId: callId,
            payload: { line, operation: "read" },
            targetInstance: instance,
            targetId: task,
            ...(taskAssociation.kind !== "one"
                ? {}
                : {
                      taskId: taskAssociation.taskId,
                      taskRevision: taskAssociation.revision,
                      todoItemId: taskAssociation.todoItemId,
                  }),
            ...(ownerWorkspace === undefined
                ? {}
                : { workspace: ownerWorkspace }),
        });
        this.#ensureTmuxWaitTracker(
            this.#instanceName,
            wait.waitId,
            context,
            callId,
            (gateway, signal) =>
                this.#trackTmuxReadReady(
                    gateway,
                    instance,
                    task,
                    context,
                    signal,
                    line,
                    startedAt + timeout,
                ),
        );

        const settled = await this.#settleTmuxWait(
            gateway,
            wait.waitId,
            context.ctxId,
            instance,
            "tmux_read",
            executionEpoch,
            signal,
        );
        if (settled.kind === "detached") return { ...observed, detached: true };
        if (settled.kind === "resolved") {
            return await this.#invokeTmuxRead(
                instance,
                task,
                context,
                { line, timeMs: 0 },
                "result",
            );
        }
        throw settled.error;
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
        if (
            !isRecord(started) ||
            !isRecord(started.task) ||
            typeof started.task.id !== "string"
        ) {
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
            return { ...started, ...completed };
        }

        const task = started.task.id;
        const goal = await this.#currentGoal(this.#instanceName, context.ctxId);
        const taskAssociation =
            goal === undefined
                ? await readCurrentTaskAssociation(
                      gateway,
                      this.#instanceName,
                      context.ctxId,
                  )
                : { kind: "none" as const };
        const goalStep = goal?.steps.find((step) => step.status === "active");
        const wait = await gateway.createWait(this.#instanceName, {
            automaticRecovery:
                this.#catalog.getExposed("workspace_open") !== undefined &&
                taskAssociation.kind !== "ambiguous",
            createdByCtxId: context.ctxId,
            ...(timeout === undefined
                ? {}
                : { deadlineAt: new Date(startedAt + timeout).toISOString() }),
            ...(goal === undefined
                ? {}
                : {
                      goalId: goal.goalId,
                      goalProgressAt: goal.lastProgressAt,
                      ...(goal.progressEpoch === undefined
                          ? {}
                          : { goalProgressEpoch: goal.progressEpoch }),
                      goalRevision: goal.revision,
                  }),
            ...(goalStep === undefined ? {} : { goalStepId: goalStep.id }),
            kind: "tmux",
            ownerCallId: callId,
            payload: { line },
            targetInstance: instance,
            targetId: task,
            ...(taskAssociation.kind !== "one"
                ? {}
                : {
                      taskId: taskAssociation.taskId,
                      taskRevision: taskAssociation.revision,
                      todoItemId: taskAssociation.todoItemId,
                  }),
            ...(ownerWorkspace === undefined
                ? {}
                : { workspace: ownerWorkspace }),
        });
        this.#ensureTmuxWaitTracker(
            this.#instanceName,
            wait.waitId,
            context,
            callId,
            (gateway, signal) =>
                this.#trackTmuxTask(
                    gateway,
                    instance,
                    task,
                    context,
                    signal,
                    timeout === undefined ? undefined : startedAt + timeout,
                ),
        );

        const settled = await this.#settleTmuxWait(
            gateway,
            wait.waitId,
            context.ctxId,
            instance,
            "tmux_run",
            executionEpoch,
            signal,
        );
        if (settled.kind === "detached") return { ...started, detached: true };
        if (settled.kind === "throw") throw settled.error;
        if (settled.result === undefined || !isRecord(settled.result)) {
            throw new Error(
                "tmux_run wait resolved without a task result.",
            );
        }
        if (isTmuxTaskRunning(settled.result, task)) {
            const completed = await this.#readTmuxTaskOutput(
                instance,
                task,
                line,
                context,
                signal,
            );
            return { ...started, ...settled.result, ...completed };
        }
        const completed = await this.#readTmuxTaskOutput(
            instance,
            task,
            line,
            context,
        );
        return { ...started, ...settled.result, ...completed };
    }

    async #settleTmuxWait(
        gateway: McpTmuxWaitGateway,
        waitId: string,
        ctxId: string,
        instance: string,
        operation: "tmux_read" | "tmux_run",
        executionEpoch?: number,
        signal?: AbortSignal,
    ): Promise<
        | { kind: "detached" }
        | { kind: "resolved"; result?: JsonValue }
        | { kind: "throw"; error: unknown }
    > {
        let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
        const boundary = new Promise<{ kind: "boundary" }>((resolve) => {
            boundaryTimer = setTimeout(
                () => resolve({ kind: "boundary" }),
                this.#tmuxBlockSyncMs,
            );
        });
        const resolution = gateway.waitForWait(this.#instanceName, waitId).then(
            (record) => ({ kind: "wait" as const, record }),
            (error: unknown) => ({ kind: "waitError" as const, error }),
        );

        let outcome:
            | Awaited<typeof resolution>
            | { kind: "boundary" }
            | { kind: "transport" };
        try {
            outcome = await waitForMcpEndpointAbortable(
                Promise.race([resolution, boundary]),
                signal,
            );
        } catch (error) {
            if (signal?.aborted !== true) throw error;
            outcome = { kind: "transport" };
        } finally {
            if (boundaryTimer !== undefined) clearTimeout(boundaryTimer);
        }

        let current =
            outcome.kind === "wait"
                ? outcome.record
                : (await gateway.listWaits(this.#instanceName)).find(
                      (entry) => entry.waitId === waitId,
                  );
        if (outcome.kind === "transport")
            await this.#reentry.releaseExecutionActivity(
                ctxId,
                executionEpoch,
                instance,
            );
        if (
            (outcome.kind === "boundary" && current?.status === "waiting") ||
            (outcome.kind === "transport" &&
                (current?.status === "waiting" ||
                    (current?.status === "resolved" &&
                        current.detachedAt === undefined)))
        ) {
            try {
                current = await gateway.detachWait(this.#instanceName, waitId);
            } catch {
                current = (await gateway.listWaits(this.#instanceName)).find(
                    (entry) => entry.waitId === waitId,
                );
            }
        }
        if (
            current?.status === "detached" ||
            (current?.status === "resolved" && current.detachedAt !== undefined)
        ) {
            return { kind: "detached" };
        }
        if (current?.status === "resolved") {
            await gateway.consumeWait(this.#instanceName, waitId);
            return { kind: "resolved", result: current.result };
        }
        if (current?.status === "cancelled" && outcome.kind === "waitError")
            return { kind: "throw", error: outcome.error };
        if (outcome.kind === "waitError")
            return { kind: "throw", error: outcome.error };
        return {
            kind: "throw",
            error: new Error(
                `${operation} wait ${waitId} entered an unexpected state.`,
            ),
        };
    }

    async #currentGoal(instance: string, ctxId: string) {
        const gateway = this.#gateway;
        if (!isMcpGoalGateway(gateway)) return undefined;
        const goal = await gateway.readGoal(instance, ctxId);
        return goal !== undefined &&
            (goal.status === "active" || goal.status === "blocked")
            ? goal
            : undefined;
    }

    #ensureTmuxWaitTracker(
        waitInstance: string,
        waitId: string,
        context: ToolCallContext,
        ownerCallId: string | undefined,
        track: (
            gateway: McpTmuxWaitGateway,
            signal: AbortSignal,
        ) => Promise<JsonValue>,
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpTmuxWaitGateway(gateway)) {
            throw new Error("tmux wait state is unavailable.");
        }
        const key = `${waitInstance}:${waitId}`;
        const existing = this.#tmuxWaitTrackers.get(key);
        if (existing !== undefined) return existing.promise;
        const controller = new AbortController();
        const tracker = track(gateway, controller.signal)
            .then(
                async (result) => {
                    const consumeIfDetached =
                        context.ctxId === undefined
                            ? false
                            : await this.#reentry.executionActive(
                                  context.ctxId,
                                  ownerCallId,
                              );
                    await gateway.resolveWait(waitInstance, waitId, result, {
                        consumeIfDetached,
                    });
                    return result;
                },
                async (error: unknown) => {
                    if (!controller.signal.aborted) {
                        await gateway
                            .cancelWait(waitInstance, waitId)
                            .catch(() => undefined);
                    }
                    throw error;
                },
            )
            .finally(() => {
                this.#tmuxWaitTrackers.delete(key);
            });
        this.#tmuxWaitTrackers.set(key, { controller, promise: tracker });
        void tracker.catch(() => undefined);
        return tracker;
    }

    async restoreTmuxWaits(
        instance: string = this.#instanceName,
    ): Promise<void> {
        if (!isMcpTmuxWaitGateway(this.#gateway)) return;
        const existing = this.#tmuxWaitRestores.get(instance);
        if (existing !== undefined) {
            await existing;
            return;
        }
        const restore = (async () => {
            const waits = await this.#gateway!.listWaits!(instance);
            for (const wait of waits) {
                if (wait.kind !== "tmux" || wait.status !== "detached")
                    continue;
                const payload = isRecord(wait.payload)
                    ? wait.payload
                    : undefined;
                const context: ToolCallContext = {
                    ctxId: wait.createdByCtxId,
                    source: "mcp",
                };
                const targetInstance = wait.targetInstance ?? instance;
                const deadlineAt =
                    wait.deadlineAt === undefined
                        ? undefined
                        : Date.parse(wait.deadlineAt);
                if (payload?.operation === "read" && deadlineAt !== undefined) {
                    this.#ensureTmuxWaitTracker(
                        instance,
                        wait.waitId,
                        context,
                        wait.ownerCallId,
                        (gateway, signal) =>
                            this.#trackTmuxReadReady(
                                gateway,
                                targetInstance,
                                wait.targetId,
                                context,
                                signal,
                                readTmuxLine(payload),
                                deadlineAt,
                            ),
                    );
                } else {
                    this.#ensureTmuxWaitTracker(
                        instance,
                        wait.waitId,
                        context,
                        wait.ownerCallId,
                        (gateway, signal) =>
                            this.#trackTmuxTask(
                                gateway,
                                targetInstance,
                                wait.targetId,
                                context,
                                signal,
                                deadlineAt,
                            ),
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

    async #waitForTmuxPoll(
        deadlineAt: number | undefined,
        signal: AbortSignal,
    ): Promise<void> {
        const remaining =
            deadlineAt === undefined
                ? this.#tmuxWaitPollMs
                : Math.max(1, deadlineAt - Date.now());
        await waitForMcpEndpointAbortable(
            new Promise<void>((resolve) =>
                setTimeout(
                    resolve,
                    Math.min(this.#tmuxWaitPollMs, remaining),
                ),
            ),
            signal,
        );
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
            const remaining =
                deadlineAt === undefined
                    ? 3_600_000
                    : Math.max(0, deadlineAt - Date.now());
            if (remaining === 0) {
                return {
                    task: { id: taskId, status: "running" },
                    timedOut: true,
                };
            }
            try {
                const result = await this.#observeTmuxRead(
                    instance,
                    taskId,
                    context,
                    Math.min(3_600_000, remaining),
                    -1,
                    signal,
                );
                if (!isTmuxTaskRunning(result, taskId)) return result;
                if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
                    return { ...result, timedOut: true };
                }
                if (
                    result.waitReason === "output" ||
                    result.waitReason === undefined
                ) {
                    await this.#waitForTmuxPoll(deadlineAt, signal);
                }
            } catch (error) {
                if (!isRetryableTmuxObservationError(error)) throw error;
                await this.#waitForTmuxPoll(deadlineAt, signal);
            }
        }
    }

    async #trackTmuxReadReady(
        gateway: McpTmuxWaitGateway,
        instance: string,
        taskId: string,
        context: ToolCallContext,
        signal: AbortSignal,
        line: number,
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
                    remaining,
                    line,
                    signal,
                );
                if (tmuxReadReady(result, line)) return result;
                if (Date.now() >= deadlineAt)
                    return { ...result, waitReason: "timeout" };
                if (line < 0 && result.waitReason === "output") {
                    await this.#waitForTmuxPoll(deadlineAt, signal);
                }
            } catch (error) {
                if (!isRetryableTmuxObservationError(error)) throw error;
                if (Date.now() >= deadlineAt) throw error;
                await this.#waitForTmuxPoll(deadlineAt, signal);
            }
        }
    }

    async #invokeTmuxRead(
        instance: string,
        taskId: string,
        context: ToolCallContext,
        input: { consumeOutput?: boolean; line: number; timeMs?: number },
        resultKind: "observation" | "result",
        signal?: AbortSignal,
    ): Promise<Record<string, JsonValue>> {
        const result = await this.#invokeToolInternal(
            instance,
            "tmux_read",
            { ...input, task: taskId },
            context,
            signal,
        );
        if (!isRecord(result))
            throw new Error(
                `tmux_read returned an invalid ${resultKind} for task ${taskId}.`,
            );
        return result;
    }

    async #observeTmuxRead(
        instance: string,
        taskId: string,
        context: ToolCallContext,
        timeMs: number,
        line: number,
        signal?: AbortSignal,
    ): Promise<Record<string, JsonValue>> {
        return await this.#invokeTmuxRead(
            instance,
            taskId,
            context,
            { consumeOutput: false, line, timeMs },
            "observation",
            signal,
        );
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
                wait.kind !== "tmux" ||
                wait.createdByCtxId !== ctxId ||
                wait.targetId !== taskId ||
                (wait.targetInstance ?? this.#instanceName) !== targetInstance
            )
                continue;
            if (wait.status === "resolved" && wait.detachedAt !== undefined) {
                await gateway
                    .consumeWait(this.#instanceName, wait.waitId)
                    .catch(() => undefined);
                continue;
            }
            if (wait.status !== "detached") continue;
            const deadline =
                wait.deadlineAt === undefined
                    ? Number.NaN
                    : Date.parse(wait.deadlineAt);
            const triggerAlreadyObserved =
                Number.isFinite(deadline) && deadline <= now;
            if (!replacePending && running && !triggerAlreadyObserved) continue;
            await gateway
                .cancelWait(this.#instanceName, wait.waitId)
                .catch(() => undefined);
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
        return await this.#invokeTmuxRead(
            instance,
            taskId,
            context,
            { line },
            "result",
            signal,
        );
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
                throw new Error(
                    `Internal worker invocation is unavailable for ${instance}.`,
                );
            }
            return await this.#worker.invokeToolInternal(
                toolName,
                input,
                context,
                signal,
            );
        }
        const gateway = this.#gateway;
        if (gateway === undefined)
            throw new Error(`Instance gateway is unavailable for ${instance}.`);
        if (gateway.invokeToolInternal === undefined) {
            throw new Error(
                `Internal worker invocation is unavailable for ${instance}.`,
            );
        }
        return await gateway.invokeToolInternal(
            instance,
            toolName,
            input,
            context,
            signal,
        );
    }

    #interruptTmuxWaitTracker(instance: string, waitId: string): void {
        this.#tmuxWaitTrackers
            .get(`${instance}:${waitId}`)
            ?.controller.abort("Workspace interrupted tmux_run");
    }

    #createToolContext(
        record: McpContextRecord,
        requestContext: McpEndpointCallContext,
        instance: string,
        signal?: AbortSignal,
    ): ToolCallContext {
        const environment = contextEnvironment(record, instance);
        const context: ToolCallContext = {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
            source: "mcp",
            ...(environment?.workspace === undefined
                ? {}
                : { workspace: environment.workspace }),
        };
        throwIfMcpEndpointAborted(signal);
        return context;
    }

    async #resolveAppOnlyContext(
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        touch: boolean,
    ): Promise<{ input: JsonValue; record: McpContextRecord }> {
        const contextInput = readMcpContextInput(input);
        const record = touch
            ? await this.#contextRegistry.validateAndTouch(contextInput.ctxId, {
                  principal: requestContext.principal,
              })
            : await this.#contextRegistry.validate(contextInput.ctxId, {
                  principal: requestContext.principal,
              });
        return { input: contextInput.input, record };
    }

    async #appendMcpToolCalled(
        instance: string,
        toolName: string,
        context: { requestId?: string; ctxId?: string },
    ): Promise<void> {
        if (instance === this.#instanceName) {
            await this.#worker.appendMcpToolCalled(toolName, context);
            return;
        }
        if (this.#gateway !== undefined) {
            await this.#gateway.appendMcpToolCalled(
                instance,
                toolName,
                context,
            );
        }
    }

    async #touchAlerts(
        instance: string,
        workspace: string,
    ): Promise<{ advice: Array<{ code: string; text: string }> }> {
        if (instance === this.#instanceName) {
            const result = await this.#worker.touchAlerts?.(workspace);
            return result === undefined ? { advice: [] } : result;
        }
        const result = await this.#gateway?.touchAlerts(instance, workspace);
        return result === undefined ? { advice: [] } : result;
    }

    async #auditControlTool(
        owner: "artifact" | "extension" | "workspace" | "todo",
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        instance: string,
        prepareCall: (callId: string, value: ToolCallHookValue) => Promise<McpAcceptedCall>,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        let nativeResult: McpNativeToolResult | undefined;
        const structuredResult = await callMcpEndpointToolOperation({
            context,
            gateway: this.#gateway,
            input,
            localInstance: this.#instanceName,
            operation: async (callId, operationInput, value) => {
                await prepareCall(callId, value);
                const result = await this.#callControlTool(
                    owner,
                    value.toolName,
                    operationInput,
                    value.context,
                    value.context.instance,
                    callId,
                    signal,
                );
                if (result instanceof McpNativeToolResult) {
                    const structuredContent = result.structuredContent;
                    nativeResult = new McpNativeToolResult({
                        ...(result._meta === undefined
                            ? {}
                            : { _meta: result._meta }),
                        content: result.content,
                        isError: result.isError,
                        structuredContent,
                    });
                    return structuredContent;
                }
                return result;
            },
            signal,
            targetInstance: instance,
            toolName,
        });
        if (nativeResult === undefined) return structuredResult;
        return new McpNativeToolResult({
            ...(nativeResult._meta === undefined
                ? {}
                : { _meta: nativeResult._meta }),
            content: nativeResult.content,
            isError: nativeResult.isError,
            structuredContent: structuredResult,
        });
    }

    async #callControlTool(
        owner: "artifact" | "extension" | "workspace" | "todo",
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        instance: string,
        callId: string,
        signal?: AbortSignal,
    ): Promise<McpEndpointResult> {
        switch (owner) {
            case "artifact":
                return await this.#artifact.call(
                    toolName as McpToolCatalogArtifactName,
                    input,
                    context,
                    signal,
                );
            case "extension": {
                const callExtensionTool = this.#gateway?.callExtensionTool;
                if (callExtensionTool === undefined)
                    throw new Error(
                        "MCP Extension tool invocation is unavailable.",
                    );
                const result = await callExtensionTool.call(
                    this.#gateway,
                    instance,
                    toolName,
                    input,
                    context,
                    callId,
                    signal,
                );
                return new McpNativeToolResult({
                    content: [...(result.content ?? [])],
                    isError: result.isError,
                    structuredContent: result.structuredContent,
                });
            }
            case "workspace":
                return await this.#workspace.call(
                    toolName as McpToolCatalogWorkspaceName,
                    input,
                    context,
                    callId,
                    signal,
                );
            case "todo":
                return await this.#todo.call(
                    toolName as McpToolCatalogTodoName,
                    input,
                    context,
                    signal,
                );
        }
    }
}

function isAppOnlyInteractionTool(toolName: string): boolean {
    return (
        toolName === "workspace_reconnect" ||
        toolName === "workspace_snapshot" ||
        toolName === "workspace_watch" ||
        toolName === "workspace_reentry" ||
        toolName === "workspace_action"
    );
}

function isPassiveWorkspaceRead(toolName: string): boolean {
    return (
        toolName === "workspace_reconnect" ||
        toolName === "workspace_snapshot" ||
        toolName === "workspace_watch"
    );
}

const OBSERVATION_TOOLS = new Set([
    "artifact_share",
    "artifact_viewImage",
    "file_glob",
    "file_grep",
    "file_read",
    "instance_list",
    "instance_status",
    "tmux_inspect",
    "todo_read",
    "workspace_open",
]);

const MUTATION_TOOLS = new Set(["file_edit", "todo_write"]);

function workspaceGoalActivity(
    toolName: string,
    input: JsonValue,
    tmuxBlockSyncMs: number,
    meta?: JsonValue,
): GoalActivityKind {
    const declared = mcpToolActivity(meta);
    if (declared !== undefined) return declared;
    if (toolName === "workspace_ask") return "wait";
    if (toolName === "tmux_run")
        return readTmuxBlock(input) ? "wait" : "execution";
    if (toolName === "tmux_read")
        return readTmuxReadTimeMs(input) >= tmuxBlockSyncMs
            ? "wait"
            : "observation";
    if (
        toolName === "tmux_manage" &&
        isRecord(input) &&
        input.command === "list"
    )
        return "observation";
    if (OBSERVATION_TOOLS.has(toolName)) return "observation";
    if (MUTATION_TOOLS.has(toolName)) return "mutation";
    return "execution";
}

function readTmuxBlock(input: JsonValue): boolean {
    return isRecord(input) && input.wait === "block";
}

function readTmuxTimeout(input: JsonValue): number | undefined {
    if (!isRecord(input) || input.timeout === undefined) return undefined;
    if (
        typeof input.timeout !== "number" ||
        !Number.isInteger(input.timeout) ||
        input.timeout < 1
    ) {
        throw new Error(
            "tmux_run timeout must be a positive integer in milliseconds.",
        );
    }
    return input.timeout;
}

function readTmuxReadTask(input: JsonValue): string {
    if (
        !isRecord(input) ||
        typeof input.task !== "string" ||
        input.task.trim().length === 0
    ) {
        throw new Error("tmux_read task must be a non-empty string.");
    }
    return input.task.trim();
}

function readTmuxReadTimeMs(input: JsonValue): number {
    if (!isRecord(input) || input.timeMs === undefined) return 0;
    if (
        typeof input.timeMs !== "number" ||
        !Number.isInteger(input.timeMs) ||
        input.timeMs < 0 ||
        input.timeMs > 3_600_000
    ) {
        throw new Error(
            "tmux_read timeMs must be an integer between 0 and 3600000.",
        );
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
        throw new Error(
            "tmux_run line must be an integer between -400 and 400.",
        );
    }
    return input.line;
}

function isTmuxTaskRunning(result: JsonValue, taskId: string): boolean {
    if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result)
    ) {
        throw new Error(
            `tmux task observation for ${taskId} returned an invalid result.`,
        );
    }
    const task = result.task;
    if (
        typeof task !== "object" ||
        task === null ||
        Array.isArray(task) ||
        task.id !== taskId ||
        typeof task.status !== "string"
    ) {
        throw new Error(
            `tmux task observation for ${taskId} returned an invalid task.`,
        );
    }
    return task.status === "running";
}

function tmuxReadReady(result: JsonValue, line: number): boolean {
    if (!isRecord(result)) return false;
    return (
        result.waitReason === "terminal" ||
        (line >= 0 && result.waitReason === "output")
    );
}

function isRetryableTmuxObservationError(error: unknown): boolean {
    const body = toRemoteErrorBody(error);
    return (
        body?.retryable === true ||
        body?.code === runtimeErrorCodes.instanceNotReady ||
        body?.code === runtimeErrorCodes.workerTransportDisconnected ||
        body?.code === runtimeErrorCodes.reverseTransportUnavailable
    );
}

function hasToolProvenance(provenance: ToolCallProvenance): boolean {
    return (
        provenance.purpose !== undefined || provenance.explanation !== undefined
    );
}

function contextEnvironment(
    record: McpContextRecord,
    instance: string,
): McpContextEnvironment | undefined {
    return record.environments.find(
        (environment) => environment.instance === instance,
    );
}

function appendWorkspaceAdvice(
    result: McpEndpointResult,
    comments: readonly string[],
): McpEndpointResult {
    if (comments.length === 0) return result;
    if (result instanceof McpNativeToolResult) {
        return new McpNativeToolResult({
            ...(result._meta === undefined ? {} : { _meta: result._meta }),
            content: result.content,
            isError: result.isError,
            structuredContent: appendStructuredComments(
                result.structuredContent,
                comments,
            ),
        });
    }
    return appendStructuredComments(result, comments);
}

function appendStructuredComments(
    value: JsonValue,
    comments: readonly string[],
): JsonValue {
    if (!isRecord(value)) return value;
    const existing = Array.isArray(value.comment)
        ? value.comment.filter(
              (entry): entry is string =>
                  typeof entry === "string" && entry.length > 0,
          )
        : [];
    return {
        ...value,
        comment: [...new Set([...existing, ...comments])],
    };
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
