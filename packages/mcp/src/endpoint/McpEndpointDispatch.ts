import {
    createError,
    errorCodes,
    type JsonValue,
    type ToolCallContext,
    type ToolDefinition
} from "@portable-devshell/shared";

import { McpContextRegistry } from "../context/McpContextRegistry.js";
import type { McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import type { McpToolCatalogArtifactName } from "../tool/catalog/McpToolCatalogArtifact.js";
import type { McpToolCatalogInstanceName } from "../tool/catalog/McpToolCatalogInstance.js";
import type { McpToolCatalogTodoName } from "../tool/catalog/McpToolCatalogTodo.js";
import {
    throwIfMcpEndpointAborted,
    waitForMcpEndpointAbortable
} from "./McpEndpointCancellation.js";
import {
    type McpEndpointCatalog,
    type McpEndpointCatalogWorker
} from "./McpEndpointCatalog.js";
import {
    assertMcpNoArguments,
    readMcpArtifactShareInput,
    readMcpArtifactTransferInput,
    readMcpContextInput,
    readMcpInstanceName,
    readMcpRoutedInput,
    readMcpSshCreateInput
} from "./McpEndpointInput.js";

export interface McpEndpointWorkerPort extends McpEndpointCatalogWorker {
    auditToolCall<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: () => Promise<T>,
        signal?: AbortSignal
    ): Promise<T>;
    appendMcpSessionClosed(sessionId: string): Promise<void>;
    appendMcpSessionOpened(sessionId: string): Promise<void>;
    appendMcpToolCalled(
        toolName: string,
        context: { requestId?: string; ctxId?: string }
    ): Promise<void>;
    callTool(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue>;
    readonly handshake?: McpEndpointEnvironmentHandshake;
    readonly workspacePath?: string;
}

export interface McpEndpointEnvironmentHandshake {
    instance: string;
    workspace: string;
    platform: {
        arch: string;
        distribution?: {
            id: string;
            name: string;
            version?: string;
        };
        os: string;
        packageManager?: string;
        shell?: {
            executable: string;
            kind: string;
            version: string;
        };
    };
}

export interface McpEndpointCallContext {
    principal: string;
    requestId?: string;
}

export interface McpEndpointDispatchOptions {
    catalog: McpEndpointCatalog;
    contextRegistry?: McpContextRegistry;
    gateway?: McpInstanceGateway;
    instanceName: string;
    worker: McpEndpointWorkerPort;
}

export class McpEndpointDispatch {
    readonly #catalog: McpEndpointCatalog;
    readonly #contextRegistry: McpContextRegistry;
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #worker: McpEndpointWorkerPort;

    constructor(options: McpEndpointDispatchOptions) {
        this.#catalog = options.catalog;
        this.#contextRegistry = options.contextRegistry ?? new McpContextRegistry();
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#worker = options.worker;
    }

    assertReady(
        worker: Pick<McpEndpointCatalogWorker, "snapshot"> = this.#worker,
        instanceName: string = this.#instanceName
    ): void {
        if (!worker.snapshot().ready) {
            throw createError({
                code: errorCodes.coreInstanceNotReady,
                details: { instance: instanceName },
                message: `Instance ${instanceName} is not ready.`,
                retryable: false
            });
        }
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        throwIfMcpEndpointAborted(signal);
        const snapshot = this.#catalog.snapshot();
        const known = snapshot.merged.find((entry) => {
            return entry.definition.name === toolName;
        });
        const selected = snapshot.exposed.find((entry) => {
            return entry.definition.name === toolName;
        });

        if (known?.owner === "environment") {
            return await this.#callEnvironmentTool(
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

        if (
            known?.owner === "todo" ||
            known?.owner === "artifact" ||
            known?.owner === "instance"
        ) {
            if (selected === undefined) {
                throw this.#toolNotExposed(toolName);
            }
            const owner = known.owner;
            this.#catalog.assertAdaptable(selected.definition);
            return await this.#worker.auditToolCall(
                toolName,
                input,
                context,
                async () => await this.#callControlTool(
                    owner,
                    toolName,
                    input,
                    context,
                    signal
                ),
                signal
            );
        }

        return await this.#callWorkerTool(
            toolName,
            input,
            context,
            selected?.definition,
            snapshot.instanceRoutingEnabled,
            signal
        );
    }

    async #callEnvironmentTool(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        exposed: boolean,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        if (!exposed) {
            throw this.#toolNotExposed(toolName);
        }
        assertMcpNoArguments(input, toolName);
        const environment = this.#requireEnvironment();
        const record = await this.#contextRegistry.create({
            instance: this.#instanceName,
            principal: requestContext.principal,
            workspace: environment.workspace
        });
        await this.#worker.appendMcpToolCalled(toolName, {
            ctxId: record.ctxId,
            requestId: requestContext.requestId
        });
        const context: ToolCallContext = {
            ctxId: record.ctxId,
            requestId: requestContext.requestId,
            source: "mcp"
        };
        return await this.#worker.auditToolCall(
            toolName,
            {},
            context,
            async () => ({
                ctxId: record.ctxId,
                expiresAt: record.expiresAt,
                instance: this.#instanceName,
                platform: {
                    arch: environment.platform.arch,
                    ...(environment.platform.distribution === undefined
                        ? {}
                        : { distribution: environment.platform.distribution }),
                    os: environment.platform.os,
                    ...(environment.platform.packageManager === undefined
                        ? {}
                        : { packageManager: environment.platform.packageManager }),
                    ...(environment.platform.shell === undefined
                        ? {}
                        : { shell: environment.platform.shell.kind })
                },
                workspace: environment.workspace
            }),
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
                return await this.#callArtifactTool(
                    toolName as McpToolCatalogArtifactName,
                    input,
                    signal
                );
            case "instance":
                return await this.#callInstanceTool(
                    toolName as McpToolCatalogInstanceName,
                    input,
                    signal
                );
            case "todo":
                return await this.#callTodoTool(
                    toolName as McpToolCatalogTodoName,
                    input,
                    context,
                    signal
                );
        }
    }

    async #callWorkerTool(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        selected: ToolDefinition | undefined,
        instanceRoutingEnabled: boolean,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const routed = readMcpRoutedInput(
            input,
            instanceRoutingEnabled,
            this.#instanceName
        );

        if (routed.instance === this.#instanceName) {
            this.assertReady();
            if (selected === undefined) {
                throw this.#toolNotExposed(toolName);
            }
            this.#catalog.assertAdaptable(selected);
            return await this.#worker.callTool(
                toolName,
                routed.input,
                context,
                signal
            );
        }

        const gateway = this.#requireGateway();
        gateway.assertReady(routed.instance);
        const targetTool = gateway.listTools(routed.instance).find((tool) => {
            return tool.name === toolName;
        });
        if (targetTool === undefined || !this.#catalog.isAllowed(targetTool)) {
            throw this.#toolNotExposed(toolName, routed.instance);
        }
        this.#catalog.assertAdaptable(targetTool);
        return await gateway.callTool(
            routed.instance,
            toolName,
            routed.input,
            context,
            signal
        );
    }

    async #callArtifactTool(
        toolName: McpToolCatalogArtifactName,
        input: JsonValue,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const gateway = this.#requireGateway();
        switch (toolName) {
            case "artifact_share":
                if (gateway.shareArtifact === undefined) {
                    throw this.#toolNotExposed(toolName);
                }
                return await waitForMcpEndpointAbortable(
                    gateway.shareArtifact(
                        this.#instanceName,
                        readMcpArtifactShareInput(input)
                    ),
                    signal
                );
            case "artifact_transfer":
                if (gateway.transferArtifact === undefined) {
                    throw this.#toolNotExposed(toolName);
                }
                return await waitForMcpEndpointAbortable(
                    gateway.transferArtifact(
                        this.#instanceName,
                        readMcpArtifactTransferInput(input)
                    ),
                    signal
                );
        }
    }

    async #callTodoTool(
        toolName: McpToolCatalogTodoName,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const gateway = this.#requireGateway();
        switch (toolName) {
            case "todo_read":
                assertMcpNoArguments(input, toolName);
                return await waitForMcpEndpointAbortable(
                    gateway.readTodo(this.#instanceName),
                    signal
                );
            case "todo_write":
                return await waitForMcpEndpointAbortable(
                    gateway.writeTodo(this.#instanceName, input, context),
                    signal
                );
        }
    }

    async #callInstanceTool(
        toolName: McpToolCatalogInstanceName,
        input: JsonValue,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const gateway = this.#requireGateway();
        switch (toolName) {
            case "instance_list":
                assertMcpNoArguments(input, toolName);
                return {
                    instances: await waitForMcpEndpointAbortable(
                        gateway.listInstances(),
                        signal
                    )
                };
            case "instance_status":
                return await waitForMcpEndpointAbortable(
                    gateway.statusInstance(readMcpInstanceName(input, toolName)),
                    signal
                );
            case "instance_start":
                return await waitForMcpEndpointAbortable(
                    gateway.startInstance(readMcpInstanceName(input, toolName)),
                    signal
                );
            case "instance_stop":
                return await waitForMcpEndpointAbortable(
                    gateway.stopInstance(readMcpInstanceName(input, toolName)),
                    signal
                );
            case "instance_create":
                return await waitForMcpEndpointAbortable(
                    gateway.createSshInstance(
                        this.#instanceName,
                        readMcpSshCreateInput(input)
                    ),
                    signal
                );
        }
    }

    #requireEnvironment(): McpEndpointEnvironmentHandshake {
        const environment = this.#worker.handshake;
        if (environment !== undefined) {
            return environment;
        }
        throw createError({
            code: errorCodes.coreWorkerHandshakeFailed,
            details: { instance: this.#instanceName },
            message: `Environment information is unavailable for ${this.#instanceName}.`,
            retryable: true
        });
    }

    #currentWorkspace(): string {
        const workspace = this.#worker.handshake?.workspace ??
            this.#worker.workspacePath;
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

    #requireGateway(): McpInstanceGateway {
        if (this.#gateway !== undefined) {
            return this.#gateway;
        }
        throw createError({
            code: errorCodes.coreToolSchemaUnavailable,
            details: { instance: this.#instanceName },
            message: `Control tools are not available for ${this.#instanceName}.`,
            retryable: false
        });
    }

    #toolNotExposed(
        toolName: string,
        instance: string = this.#instanceName
    ) {
        return createError({
            code: errorCodes.coreToolSchemaUnavailable,
            details: { instance, toolName },
            message: `Tool ${toolName} is not exposed by MCP.`,
            retryable: false
        });
    }
}
