import {
    type ControlMcpContextMode,
    createError,
    errorCodes,
    mergeComments,
    resolveResultHints,
    type JsonValue,
    type McpContextEnvironment,
    type McpContextRecord,
    type ToolCallContext
} from "@portable-devshell/shared";

import { McpContextRegistry } from "../context/McpContextRegistry.js";
import { isMcpWaitTrackingGateway, type McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import type { McpToolCatalogArtifactName } from "../tool/catalog/McpToolCatalogArtifact.js";
import type { McpToolCatalogInstanceName } from "../tool/catalog/McpToolCatalogInstance.js";
import type { McpToolCatalogInteractionName } from "../tool/catalog/McpToolCatalogInteraction.js";
import type { McpToolCatalogTodoName } from "../tool/catalog/McpToolCatalogTodo.js";
import { throwIfMcpEndpointAborted, waitForMcpEndpointAbortable } from "./McpEndpointCancellation.js";
import { mcpLegacyToolTombstone, resolveMcpLegacyTool } from "./McpEndpointCompatibility.js";
import { attachMcpComments } from "./McpEndpointFeedback.js";
import type { McpEndpointCatalog, McpEndpointCatalogWorker } from "./McpEndpointCatalog.js";
import { readMcpContextInput, readMcpRoutedInput } from "./McpEndpointInput.js";
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
    contextMode?: ControlMcpContextMode;
    gateway?: McpInstanceGateway;
    instanceName: string;
    readyWaitMs?: number;
    worker: McpEndpointWorkerPort;
}

export class McpEndpointDispatch {
    readonly #artifact: McpEndpointHandlerArtifact;
    readonly #catalog: McpEndpointCatalog;
    readonly #contextRegistry: McpContextRegistry;
    readonly #contextMode: ControlMcpContextMode;
    readonly #environment: McpEndpointHandlerEnvironment;
    readonly #gateway?: McpInstanceGateway;
    readonly #instance: McpEndpointHandlerInstance;
    readonly #instanceName: string;
    readonly #interaction: McpEndpointHandlerInteraction;
    readonly #tmuxWaitTrackers = new Map<string, { controller: AbortController; promise: Promise<JsonValue> }>();
    readonly #todo: McpEndpointHandlerTodo;
    readonly #worker: McpEndpointWorkerPort;
    readonly #workerHandler: McpEndpointHandlerWorker;

    constructor(options: McpEndpointDispatchOptions) {
        this.#catalog = options.catalog;
        this.#contextRegistry = options.contextRegistry ?? new McpContextRegistry();
        this.#contextMode = options.contextMode ?? "explicit";
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#worker = options.worker;
        const controlOptions = {
            gateway: options.gateway,
            instanceName: options.instanceName
        };
        this.#artifact = new McpEndpointHandlerArtifact(controlOptions);
        this.#environment = new McpEndpointHandlerEnvironment({
            contextRegistry: this.#contextRegistry,
            contextMode: options.contextMode ?? "explicit",
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
            contextMode: options.contextMode
        });
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

        let ctxId: string | undefined;
        if (this.#contextMode === "explicit") {
            const contextInput = readMcpContextInput(input);
            ctxId = contextInput.ctxId;
            input = contextInput.input;
        }
        const appOnlyInteraction = selected.owner === "interaction" && isAppOnlyInteractionTool(toolName);
        const routed = selected.owner === "worker" || selected.owner === "artifact"
            ? readMcpRoutedInput(input, snapshot.instanceRoutingEnabled, this.#instanceName)
            : { input, instance: this.#instanceName };
        const context = await this.#createToolContext(
            toolName,
            ctxId,
            requestContext,
            routed.instance,
            selected.owner === "worker",
            !appOnlyInteraction,
            signal
        );

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
            selected.owner === "instance" || selected.owner === "interaction"
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

        if (toolName === "tmux_wait" && isMcpWaitTrackingGateway(this.#gateway)) {
            const task = readTmuxTaskId(routed.input);
            if (task !== undefined) {
                return await this.#callTmuxWait(
                    task,
                    input,
                    context,
                    selected.definition,
                    snapshot.instanceRoutingEnabled,
                    routed.instance,
                    signal
                );
            }
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

    async #callTmuxWait(
        task: string,
        input: JsonValue,
        context: ToolCallContext,
        definition: Parameters<McpEndpointHandlerWorker["call"]>[3],
        instanceRoutingEnabled: boolean,
        instance: string,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpWaitTrackingGateway(gateway) || context.ctxId === undefined) {
            throw new Error("tmux_wait durable state is unavailable.");
        }
        const reusable = (await gateway.listWaits(instance)).find((record) =>
            record.createdByCtxId === context.ctxId &&
            record.kind === "tmux" &&
            record.targetId === task &&
            record.status !== "cancelled" &&
            record.status !== "consumed"
        );
        let wait = reusable;
        if (wait?.status === "detached") {
            wait = await gateway.reattachWait(instance, wait.waitId, context.requestId);
        }
        if (wait === undefined) {
            const taskId = await this.#currentTaskId(instance, context.ctxId);
            wait = await gateway.createWait(instance, {
                createdByCtxId: context.ctxId,
                kind: "tmux",
                ...(context.requestId === undefined ? {} : { ownerCallId: context.requestId }),
                ...(taskId === undefined ? {} : { taskId }),
                targetId: task
            });
        }
        if (wait.status !== "resolved") {
            this.#ensureTmuxWaitTracker(
                wait.waitId,
                input,
                context,
                definition,
                instanceRoutingEnabled,
                instance
            );
        }

        try {
            const resolved = wait.status === "resolved"
                ? wait
                : await waitForMcpEndpointAbortable(gateway.waitForWait(instance, wait.waitId), signal);
            const result = resolved.result;
            if (result === undefined) {
                throw new Error(`tmux wait ${wait.waitId} resolved without a result.`);
            }
            await gateway.consumeWait(instance, wait.waitId);
            return await this.#attachComments(
                "tmux_wait",
                result,
                context,
                context.requestId ?? wait.waitId,
                instance
            );
        } catch (error) {
            if (signal?.aborted === true) {
                await gateway.detachWait(instance, wait.waitId).catch(() => undefined);
                throw error;
            }
            const current = (await gateway.listWaits(instance)).find((record) => record.waitId === wait.waitId);
            if (current?.status === "cancelled") {
                return await this.#attachComments(
                    "tmux_wait",
                    {
                    interrupted: true,
                    task: { id: task, status: "running" },
                    },
                    context,
                    context.requestId ?? wait.waitId,
                    instance
                );
            }
            throw error;
        }
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
        input: JsonValue,
        context: ToolCallContext,
        definition: Parameters<McpEndpointHandlerWorker["call"]>[3],
        instanceRoutingEnabled: boolean,
        instance: string
    ): Promise<JsonValue> {
        const gateway = this.#gateway;
        if (!isMcpWaitTrackingGateway(gateway)) {
            throw new Error("tmux_wait durable state is unavailable.");
        }
        const key = `${instance}:${waitId}`;
        const existing = this.#tmuxWaitTrackers.get(key);
        if (existing !== undefined) return existing.promise;
        const controller = new AbortController();
        const tracker = this.#workerHandler.call(
            "tmux_wait",
            input,
            context,
            definition,
            instanceRoutingEnabled,
            controller.signal
        ).then(async (result) => {
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

    #interruptTmuxWaitTracker(instance: string, waitId: string): void {
        this.#tmuxWaitTrackers.get(`${instance}:${waitId}`)?.controller.abort("Workspace interrupted tmux_wait");
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
        ctxId: string | undefined,
        requestContext: McpEndpointCallContext,
        instance: string,
        prepareWorkerState: boolean,
        recordMcpCall: boolean,
        signal?: AbortSignal
    ): Promise<ToolCallContext> {
        const record = this.#contextMode === "explicit"
            ? await this.#contextRegistry.validateAndTouch(ctxId!, {
                  principal: requestContext.principal
              })
            : await this.#contextRegistry.validateAndTouchOpenAiSession(
                  requireOpenAiSessionId(requestContext),
                  {
                      instance: this.#instanceName,
                      principal: requestContext.principal
                  }
              );
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
        owner: "artifact" | "instance" | "interaction" | "todo",
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
        owner: "artifact" | "instance" | "interaction" | "todo",
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
            case "interaction":
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
    return toolName === "workspace_snapshot" ||
        toolName === "workspace_watch" ||
        toolName === "workspace_question_answer" ||
        toolName === "workspace_wait_interrupt" ||
        toolName === "workspace_task_control" ||
        toolName === "workspace_wait_recover" ||
        toolName === "workspace_approval_decide";
}

function requireOpenAiSessionId(context: McpEndpointCallContext): string {
    if (context.openAiSessionId !== undefined) return context.openAiSessionId;
    throw createError({
        code: errorCodes.mcpContextInvalid,
        message: "This endpoint uses OpenAI session context mode, but the client did not provide _meta['openai/session'].",
        retryable: false
    });
}

function readTmuxTaskId(input: JsonValue): string | undefined {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
    const task = input.task;
    return typeof task === "string" && task.trim().length > 0 ? task.trim() : undefined;
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
        message: `No workspace is attached to ${instance} for this ctxId. Call instance_connect with an absolute workspace.`,
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
