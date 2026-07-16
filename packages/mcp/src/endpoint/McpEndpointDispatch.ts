import {
    createError,
    errorCodes,
    type JsonValue,
    type ToolCallContext
} from "@portable-devshell/shared";

import { McpContextRegistry } from "../context/McpContextRegistry.js";
import type { McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import type { McpToolCatalogArtifactName } from "../tool/catalog/McpToolCatalogArtifact.js";
import type { McpToolCatalogInstanceName } from "../tool/catalog/McpToolCatalogInstance.js";
import type { McpToolCatalogTodoName } from "../tool/catalog/McpToolCatalogTodo.js";
import { throwIfMcpEndpointAborted } from "./McpEndpointCancellation.js";
import type { McpEndpointCatalog, McpEndpointCatalogWorker } from "./McpEndpointCatalog.js";
import { readMcpContextInput } from "./McpEndpointInput.js";
import type { McpEndpointCallContext, McpEndpointWorkerPort } from "./McpEndpointPort.js";
import { McpEndpointHandlerArtifact } from "./handler/McpEndpointHandlerArtifact.js";
import { McpEndpointHandlerEnvironment } from "./handler/McpEndpointHandlerEnvironment.js";
import { McpEndpointHandlerInstance } from "./handler/McpEndpointHandlerInstance.js";
import { McpEndpointHandlerTodo } from "./handler/McpEndpointHandlerTodo.js";
import { McpEndpointHandlerWorker } from "./handler/McpEndpointHandlerWorker.js";
import { assertMcpEndpointReady, mcpEndpointToolNotExposed } from "./handler/McpEndpointHandlerSupport.js";

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
    worker: McpEndpointWorkerPort;
}

export class McpEndpointDispatch {
    readonly #artifact: McpEndpointHandlerArtifact;
    readonly #catalog: McpEndpointCatalog;
    readonly #contextRegistry: McpContextRegistry;
    readonly #environment: McpEndpointHandlerEnvironment;
    readonly #instance: McpEndpointHandlerInstance;
    readonly #instanceName: string;
    readonly #todo: McpEndpointHandlerTodo;
    readonly #worker: McpEndpointWorkerPort;
    readonly #workerHandler: McpEndpointHandlerWorker;

    constructor(options: McpEndpointDispatchOptions) {
        this.#catalog = options.catalog;
        this.#contextRegistry = options.contextRegistry ?? new McpContextRegistry();
        this.#instanceName = options.instanceName;
        this.#worker = options.worker;
        const controlOptions = {
            gateway: options.gateway,
            instanceName: options.instanceName
        };
        this.#artifact = new McpEndpointHandlerArtifact(controlOptions);
        this.#environment = new McpEndpointHandlerEnvironment({
            contextRegistry: this.#contextRegistry,
            instanceName: options.instanceName,
            worker: options.worker
        });
        this.#instance = new McpEndpointHandlerInstance(controlOptions);
        this.#todo = new McpEndpointHandlerTodo(controlOptions);
        this.#workerHandler = new McpEndpointHandlerWorker({
            catalog: options.catalog,
            gateway: options.gateway,
            instanceName: options.instanceName,
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
    ): Promise<JsonValue> {
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
                signal
            );
        }

        const contextInput = readMcpContextInput(input);
        const context = await this.#createToolContext(
            toolName,
            contextInput.ctxId,
            requestContext,
            signal
        );
        input = contextInput.input;

        if (known?.owner === "todo" || known?.owner === "artifact" || known?.owner === "instance") {
            if (selected === undefined) {
                throw mcpEndpointToolNotExposed(toolName, this.#instanceName);
            }
            const owner = known.owner;
            this.#catalog.assertAdaptable(selected.definition);
            return await this.#worker.auditToolCall(
                toolName,
                input,
                context,
                async () => await this.#callControlTool(owner, toolName, input, context, signal),
                signal
            );
        }

        return await this.#workerHandler.call(
            toolName,
            input,
            context,
            selected?.definition,
            snapshot.instanceRoutingEnabled,
            signal
        );
    }

    async #createToolContext(
        toolName: string,
        ctxId: string,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal
    ): Promise<ToolCallContext> {
        const record = await this.#contextRegistry.validateAndTouch(ctxId, {
            instance: this.#instanceName,
            principal: requestContext.principal,
            workspace: this.#currentWorkspace()
        });
        const context: ToolCallContext = {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
            source: "mcp"
        };
        await this.#worker.appendMcpToolCalled(toolName, {
            ctxId: context.ctxId,
            requestId: context.requestId
        });
        throwIfMcpEndpointAborted(signal);
        return context;
    }

    async #callControlTool(
        owner: "artifact" | "instance" | "todo",
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        switch (owner) {
            case "artifact":
                return await this.#artifact.call(toolName as McpToolCatalogArtifactName, input, signal);
            case "instance":
                return await this.#instance.call(toolName as McpToolCatalogInstanceName, input, signal);
            case "todo":
                return await this.#todo.call(toolName as McpToolCatalogTodoName, input, context, signal);
        }
    }

    #currentWorkspace(): string {
        const workspace = this.#worker.handshake?.workspace ?? this.#worker.workspacePath;
        if (workspace !== undefined && workspace.length > 0) {
            return workspace;
        }
        throw createError({
            code: errorCodes.coreWorkerHandshakeFailed,
            details: { instance: this.#instanceName },
            message: `Workspace information is unavailable for ${this.#instanceName}.`,
            retryable: true
        });
    }
}
