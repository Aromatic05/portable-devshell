import {
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
import type { McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import type { McpToolCatalogArtifactName } from "../tool/catalog/McpToolCatalogArtifact.js";
import type { McpToolCatalogInstanceName } from "../tool/catalog/McpToolCatalogInstance.js";
import type { McpToolCatalogTodoName } from "../tool/catalog/McpToolCatalogTodo.js";
import { throwIfMcpEndpointAborted } from "./McpEndpointCancellation.js";
import { attachMcpComments } from "./McpEndpointFeedback.js";
import type { McpEndpointCatalog, McpEndpointCatalogWorker } from "./McpEndpointCatalog.js";
import { readMcpContextInput, readMcpRoutedInput } from "./McpEndpointInput.js";
import type { McpEndpointCallContext, McpEndpointWorkerPort } from "./McpEndpointPort.js";
import { McpNativeToolResult, type McpEndpointResult } from "./McpEndpointResult.js";
import { McpEndpointHandlerArtifact } from "./handler/McpEndpointHandlerArtifact.js";
import { McpEndpointHandlerEnvironment } from "./handler/McpEndpointHandlerEnvironment.js";
import { McpEndpointHandlerInstance } from "./handler/McpEndpointHandlerInstance.js";
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
    gateway?: McpInstanceGateway;
    instanceName: string;
    readyWaitMs?: number;
    worker: McpEndpointWorkerPort;
}

export class McpEndpointDispatch {
    readonly #artifact: McpEndpointHandlerArtifact;
    readonly #catalog: McpEndpointCatalog;
    readonly #contextRegistry: McpContextRegistry;
    readonly #environment: McpEndpointHandlerEnvironment;
    readonly #gateway?: McpInstanceGateway;
    readonly #instance: McpEndpointHandlerInstance;
    readonly #instanceName: string;
    readonly #todo: McpEndpointHandlerTodo;
    readonly #worker: McpEndpointWorkerPort;
    readonly #workerHandler: McpEndpointHandlerWorker;

    constructor(options: McpEndpointDispatchOptions) {
        this.#catalog = options.catalog;
        this.#contextRegistry = options.contextRegistry ?? new McpContextRegistry();
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
            gateway: options.gateway,
            instanceName: options.instanceName,
            worker: options.worker
        });
        this.#instance = new McpEndpointHandlerInstance({
            ...controlOptions,
            contextRegistry: this.#contextRegistry
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
        const snapshot = this.#catalog.snapshot();
        const known = snapshot.merged.find((entry) => entry.definition.name === toolName);
        const selected = snapshot.exposed.find((entry) => entry.definition.name === toolName);

        if (known?.owner === "environment") {
            return await this.#environment.call(
                toolName,
                input,
                requestContext,
                selected !== undefined,
                snapshot.instanceRoutingEnabled,
                signal
            );
        }

        if (selected === undefined) {
            throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
        }

        const contextInput = readMcpContextInput(input);
        input = contextInput.input;
        const routed = selected.owner === "worker" || selected.owner === "artifact"
            ? readMcpRoutedInput(input, snapshot.instanceRoutingEnabled, this.#instanceName)
            : { input, instance: this.#instanceName };
        const context = await this.#createToolContext(
            toolName,
            contextInput.ctxId,
            requestContext,
            routed.instance,
            selected.owner === "worker",
            signal
        );

        if (selected.owner === "todo" || selected.owner === "artifact" || selected.owner === "instance") {
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
        ctxId: string,
        requestContext: McpEndpointCallContext,
        instance: string,
        prepareWorkerState: boolean,
        signal?: AbortSignal
    ): Promise<ToolCallContext> {
        const record = await this.#contextRegistry.validateAndTouch(ctxId, {
            principal: requestContext.principal
        });
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
        await this.#appendMcpToolCalled(instance, toolName, {
            ctxId: context.ctxId,
            requestId: context.requestId
        });
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
        owner: "artifact" | "instance" | "todo",
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
                const result = await this.#callControlTool(owner, toolName, input, context, signal);
                if (result instanceof McpNativeToolResult) {
                    const structuredContent = await this.#attachComments(toolName, result.structuredContent, context, callId, instance);
                    nativeResult = new McpNativeToolResult({
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
        owner: "artifact" | "instance" | "todo",
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<McpEndpointResult> {
        switch (owner) {
            case "artifact":
                return await this.#artifact.call(toolName as McpToolCatalogArtifactName, input, context, signal);
            case "instance":
                return await this.#instance.call(toolName as McpToolCatalogInstanceName, input, context, signal);
            case "todo":
                return await this.#todo.call(toolName as McpToolCatalogTodoName, input, context, signal);
        }
    }

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
