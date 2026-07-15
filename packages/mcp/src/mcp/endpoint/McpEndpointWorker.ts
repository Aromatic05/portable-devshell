import {
    createError,
    errorCodes,
    type JsonValue,
    type ToolCallContext,
    type ToolDefinition,
    type ToolPolicy
} from "@portable-devshell/shared";

import type {
    ArtifactShareInput,
    ArtifactTransferCancelInput,
    ArtifactTransferLookupInput,
    ArtifactTransferStartInput
} from "@portable-devshell/shared";

import { McpArtifactToolCatalog, type McpArtifactToolName } from "../artifact/McpArtifactToolCatalog.js";
import { McpContextRegistry } from "../context/McpContextRegistry.js";
import { McpEnvironmentToolCatalog, mcpEnvironmentToolName } from "../environment/McpEnvironmentToolCatalog.js";
import type { McpInstanceGateway, McpSshInstanceCreateInput } from "../instance/McpInstanceGateway.js";
import { McpInstanceToolCatalog, type McpInstanceToolName } from "../instance/McpInstanceToolCatalog.js";
import { McpTodoToolCatalog, type McpTodoToolName } from "../todo/McpTodoToolCatalog.js";
import { McpToolDescriptionEnhancer } from "../tool/McpToolDescriptionEnhancer.js";
import { McpToolSchemaAdapter, McpToolSchemaUnavailableError, type McpTool } from "../tool/McpToolSchemaAdapter.js";
import {
    McpEndpointToolCatalog,
    type McpEndpointToolEntry,
    type McpEndpointToolSource
} from "./McpEndpointToolCatalog.js";

interface WorkerInstanceLike {
    auditToolCall<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: () => Promise<T>,
        signal?: AbortSignal
    ): Promise<T>;
    appendMcpSessionClosed(sessionId: string): Promise<void>;
    appendMcpSessionOpened(sessionId: string): Promise<void>;
    appendMcpToolCalled(toolName: string, context: { requestId?: string; ctxId?: string }): Promise<void>;
    callTool(toolName: string, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue>;
    readonly handshake?: WorkerEnvironmentHandshake;
    readonly workspacePath?: string;
    hasToolSchemaCache?(): boolean;
    listTools(): ToolDefinition[];
    snapshot(): { ready?: boolean };
}

interface WorkerEnvironmentHandshake {
    instance: string;
    workspace: string;
    platform: {
        arch: string;
        distribution?: { id: string; name: string; version?: string };
        os: string;
        packageManager?: string;
        shell?: { executable: string; kind: string; version: string };
    };
}

export interface McpEndpointCallContext {
    principal: string;
    requestId?: string;
}

export class McpEndpointWorker {
    readonly #artifactTools = new McpArtifactToolCatalog();
    readonly #catalog: McpEndpointToolCatalog;
    readonly #contextRegistry: McpContextRegistry;
    readonly #descriptionEnhancer = new McpToolDescriptionEnhancer();
    readonly #environmentTools = new McpEnvironmentToolCatalog();
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #instanceTools = new McpInstanceToolCatalog();
    readonly #schemaAdapter = new McpToolSchemaAdapter();
    readonly #todoTools = new McpTodoToolCatalog();
    readonly #worker: WorkerInstanceLike;

    constructor(options: {
        contextRegistry?: McpContextRegistry;
        gateway?: McpInstanceGateway;
        instanceName: string;
        policy: ToolPolicy;
        worker: WorkerInstanceLike;
    }) {
        this.#catalog = new McpEndpointToolCatalog(options.policy);
        this.#contextRegistry = options.contextRegistry ?? new McpContextRegistry();
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#worker = options.worker;
    }

    get instanceName(): string {
        return this.#instanceName;
    }

    assertReady(worker: WorkerInstanceLike = this.#worker, instanceName: string = this.#instanceName): void {
        if (!worker.snapshot().ready) {
            throw createError({
                code: errorCodes.coreInstanceNotReady,
                details: { instance: instanceName },
                message: `Instance ${instanceName} is not ready.`,
                retryable: false
            });
        }
    }

    listTools(): McpTool[] {
        const { exposed, hasWorkerSchema } = this.#resolveCatalog();
        if (!hasWorkerSchema && exposed.length === 0) {
            throw new McpToolSchemaUnavailableError(this.#instanceName);
        }

        const instanceRoutingEnabled = exposed.some((entry) => entry.owner === "instance");
        return exposed.map((entry) =>
            this.#adaptTool(
                (entry.owner === "worker" || entry.owner === "artifact") && instanceRoutingEnabled
                    ? withInstanceTarget(entry.definition)
                    : entry.definition
            )
        );
    }

    getTool(toolName: string): ToolDefinition | undefined {
        return this.#resolveCatalog().exposed.find((entry) => entry.definition.name === toolName)?.definition;
    }

    async appendSessionOpened(sessionId: string): Promise<void> {
        await this.#worker.appendMcpSessionOpened(sessionId);
    }

    async appendSessionClosed(sessionId: string): Promise<void> {
        await this.#worker.appendMcpSessionClosed(sessionId);
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        requestContext: McpEndpointCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        throwIfAborted(signal);
        const { merged, exposed } = this.#resolveCatalog();
        const known = merged.find((entry) => entry.definition.name === toolName);
        const selected = exposed.find((entry) => entry.definition.name === toolName);

        if (known?.owner === "environment") {
            if (selected === undefined) {
                throw this.#toolNotExposed(toolName);
            }
            assertNoArguments(input, toolName);
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

        const extracted = readContextInput(input);
        const workspace = this.#currentWorkspace();
        const record = await this.#contextRegistry.validateAndTouch(extracted.ctxId, {
            instance: this.#instanceName,
            principal: requestContext.principal,
            workspace
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
        throwIfAborted(signal);
        input = extracted.input;

        if (known?.owner === "todo") {
            if (selected === undefined) {
                throw this.#toolNotExposed(toolName);
            }
            this.#adaptTool(selected.definition);
            return await this.#worker.auditToolCall(
                toolName,
                input,
                context,
                async () => await this.#callTodoTool(toolName as McpTodoToolName, input, context, signal),
                signal
            );
        }

        if (known?.owner === "artifact") {
            if (selected === undefined) {
                throw this.#toolNotExposed(toolName);
            }
            this.#adaptTool(selected.definition);
            return await this.#worker.auditToolCall(
                toolName,
                input,
                context,
                async () => await this.#callArtifactTool(toolName as McpArtifactToolName, input, signal),
                signal
            );
        }

        if (known?.owner === "instance") {
            if (selected === undefined) {
                throw this.#toolNotExposed(toolName);
            }
            this.#adaptTool(selected.definition);
            return await this.#worker.auditToolCall(
                toolName,
                input,
                context,
                async () => await this.#callInstanceTool(toolName as McpInstanceToolName, input, signal),
                signal
            );
        }

        const instanceRoutingEnabled = exposed.some((entry) => entry.owner === "instance");
        const routed = readRoutedInput(input, instanceRoutingEnabled, this.#instanceName);

        if (routed.instance === this.#instanceName) {
            this.assertReady();
            if (selected === undefined || selected.owner !== "worker") {
                throw this.#toolNotExposed(toolName);
            }
            this.#adaptTool(selected.definition);
            return await this.#worker.callTool(toolName, routed.input, context, signal);
        }

        const gateway = this.#requireGateway();
        gateway.assertReady(routed.instance);
        const targetTool = gateway.listTools(routed.instance).find((tool) => tool.name === toolName);
        if (targetTool === undefined || !this.#catalog.isAllowed(targetTool)) {
            throw this.#toolNotExposed(toolName, routed.instance);
        }
        this.#adaptTool(targetTool);
        return await gateway.callTool(routed.instance, toolName, routed.input, context, signal);
    }

    #resolveCatalog(): {
        exposed: McpEndpointToolEntry[];
        hasWorkerSchema: boolean;
        merged: McpEndpointToolEntry[];
    } {
        const hasWorkerSchema = this.#worker.snapshot().ready || this.#worker.hasToolSchemaCache?.() === true;
        const sources: McpEndpointToolSource[] = [{
            owner: "environment",
            tools: this.#environmentTools.list()
        }];

        if (hasWorkerSchema) {
            sources.push({
                owner: "worker",
                tools: this.#worker.listTools()
            });
        }
        if (this.#gateway !== undefined) {
            if (this.#gateway.shareArtifact !== undefined && this.#gateway.transferArtifact !== undefined) {
                sources.push({
                    owner: "artifact",
                    tools: this.#artifactTools.list()
                });
            }
            sources.push(
                {
                    owner: "todo",
                    tools: this.#todoTools.list()
                },
                {
                    owner: "instance",
                    tools: this.#instanceTools.list()
                }
            );
        }

        const merged = this.#catalog.merge(sources);
        return {
            exposed: this.#catalog.filter(merged),
            hasWorkerSchema,
            merged
        };
    }

    async #callArtifactTool(
        toolName: McpArtifactToolName,
        input: JsonValue,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const gateway = this.#requireGateway();
        switch (toolName) {
            case "artifact_share":
                if (gateway.shareArtifact === undefined) {
                    throw this.#toolNotExposed(toolName);
                }
                return await waitForAbortable(gateway.shareArtifact(this.#instanceName, readArtifactShareInput(input)), signal);
            case "artifact_transfer":
                if (gateway.transferArtifact === undefined) {
                    throw this.#toolNotExposed(toolName);
                }
                return await waitForAbortable(gateway.transferArtifact(this.#instanceName, readArtifactTransferInput(input)), signal);
        }
    }

    async #callTodoTool(
        toolName: McpTodoToolName,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const gateway = this.#requireGateway();
        switch (toolName) {
            case "todo_read":
                assertNoArguments(input, toolName);
                return await waitForAbortable(gateway.readTodo(this.#instanceName), signal);
            case "todo_write":
                return await waitForAbortable(gateway.writeTodo(this.#instanceName, input, context), signal);
        }
    }

    async #callInstanceTool(
        toolName: McpInstanceToolName,
        input: JsonValue,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const gateway = this.#requireGateway();
        switch (toolName) {
            case "instance_list":
                assertNoArguments(input, toolName);
                return { instances: await waitForAbortable(gateway.listInstances(), signal) };
            case "instance_status":
                return await waitForAbortable(gateway.statusInstance(readInstanceName(input, toolName)), signal);
            case "instance_start":
                return await waitForAbortable(gateway.startInstance(readInstanceName(input, toolName)), signal);
            case "instance_stop":
                return await waitForAbortable(gateway.stopInstance(readInstanceName(input, toolName)), signal);
            case "instance_create":
                return await waitForAbortable(gateway.createSshInstance(this.#instanceName, readSshCreateInput(input)), signal);
        }
    }

    #adaptTool(tool: ToolDefinition): McpTool {
        const exposed = tool.name === mcpEnvironmentToolName ? tool : withCtxId(tool);
        return this.#schemaAdapter.toMcpTool(exposed, this.#descriptionEnhancer.enhance(exposed.description));
    }

    #requireEnvironment(): WorkerEnvironmentHandshake {
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

    #toolNotExposed(toolName: string, instance: string = this.#instanceName) {
        return createError({
            code: errorCodes.coreToolSchemaUnavailable,
            details: { instance, toolName },
            message: `Tool ${toolName} is not exposed by MCP.`,
            retryable: false
        });
    }
}

function withCtxId(tool: ToolDefinition): ToolDefinition {
    if (!isRecord(tool.inputSchema)) {
        throw new McpToolSchemaUnavailableError(tool.name);
    }
    const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
    const required = Array.isArray(tool.inputSchema.required)
        ? tool.inputSchema.required.filter((entry): entry is string => typeof entry === "string")
        : [];
    return {
        ...tool,
        inputSchema: {
            ...tool.inputSchema,
            properties: {
                ...properties,
                ctxId: {
                    description: "Session context ID.",
                    minLength: 1,
                    type: "string"
                }
            },
            required: required.includes("ctxId") ? required : [...required, "ctxId"]
        }
    };
}

function readContextInput(input: JsonValue): { ctxId: string; input: JsonValue } {
    if (!isRecord(input) || typeof input.ctxId !== "string" || input.ctxId.trim().length === 0) {
        throw createError({
            code: errorCodes.mcpContextInvalid,
            message: "This tool requires the ctxId returned by environ_info.",
            retryable: false
        });
    }
    const { ctxId, ...toolInput } = input;
    return { ctxId: ctxId.trim(), input: toolInput };
}

function withInstanceTarget(tool: ToolDefinition): ToolDefinition {
    if (!isRecord(tool.inputSchema)) {
        throw new McpToolSchemaUnavailableError(tool.name);
    }
    const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
    return {
        ...tool,
        inputSchema: {
            ...tool.inputSchema,
            properties: {
                ...properties,
                instance: {
                    description: "Managed instance name returned by instance_list.",
                    minLength: 1,
                    type: "string"
                }
            }
        }
    };
}

function readRoutedInput(input: JsonValue, instanceRoutingEnabled: boolean, defaultInstance: string): { input: JsonValue; instance: string } {
    if (!isRecord(input)) {
        return { input, instance: defaultInstance };
    }
    const target = input.instance;
    if (target === undefined) {
        return { input, instance: defaultInstance };
    }
    if (!instanceRoutingEnabled) {
        throw invalidArguments("The instance argument is only available when instance management is exposed.");
    }
    if (typeof target !== "string" || target.trim().length === 0) {
        throw invalidArguments("instance must be a non-empty string.");
    }
    const { instance: _ignored, ...workerInput } = input;
    return { input: workerInput, instance: target.trim() };
}

function readArtifactShareInput(input: JsonValue): ArtifactShareInput {
    if (!isRecord(input)) {
        throw invalidArguments("artifact_share requires an object input.");
    }
    const handle = optionalString(input.handle, "handle");
    const path = optionalString(input.path, "path");
    if ((handle === undefined) === (path === undefined)) {
        throw invalidArguments("artifact_share requires exactly one of handle or path.");
    }
    const instance = optionalString(input.instance, "instance");
    const expiresInSeconds = input.expiresInSeconds;
    if (
        expiresInSeconds !== undefined &&
        (typeof expiresInSeconds !== "number" || !Number.isInteger(expiresInSeconds) || expiresInSeconds < 60)
    ) {
        throw invalidArguments("expiresInSeconds must be an integer greater than or equal to 60.");
    }
    const common = {
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
        ...(instance === undefined ? {} : { instance })
    };
    if (handle !== undefined) {
        return { ...common, handle };
    }
    if (path === undefined) {
        throw invalidArguments("artifact_share requires path when handle is omitted.");
    }
    return { ...common, path };
}

function readArtifactTransferInput(
    input: JsonValue
): ArtifactTransferStartInput | ArtifactTransferLookupInput | ArtifactTransferCancelInput {
    if (!isRecord(input)) {
        throw invalidArguments("artifact_transfer requires an object input.");
    }
    if (input.operation === "status" || input.operation === "cancel") {
        const transferId = requiredString(input.transferId, "transferId");
        return { operation: input.operation, transferId };
    }
    if (input.operation !== "start") {
        throw invalidArguments("artifact_transfer operation must be start, status, or cancel.");
    }
    const handle = optionalString(input.handle, "handle");
    const sourcePath = optionalString(input.sourcePath, "sourcePath");
    if ((handle === undefined) === (sourcePath === undefined)) {
        throw invalidArguments("artifact_transfer start requires exactly one of handle or sourcePath.");
    }
    const instance = optionalString(input.instance, "instance");
    const targetInstance = requiredString(input.targetInstance, "targetInstance");
    const targetPath = requiredString(input.targetPath, "targetPath");
    if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") {
        throw invalidArguments("overwrite must be a boolean.");
    }
    const common = {
        ...(instance === undefined ? {} : { instance }),
        operation: "start" as const,
        overwrite: input.overwrite === true,
        targetInstance,
        targetPath
    };
    if (handle !== undefined) {
        return { ...common, handle };
    }
    if (sourcePath === undefined) {
        throw invalidArguments("artifact_transfer start requires sourcePath when handle is omitted.");
    }
    return { ...common, sourcePath };
}

function assertNoArguments(input: JsonValue, toolName: string): void {
    if (!isRecord(input) || Object.keys(input).length !== 0) {
        throw invalidArguments(`${toolName} does not accept arguments.`);
    }
}

function readInstanceName(input: JsonValue, toolName: string): string {
    if (!isRecord(input) || typeof input.instance !== "string" || input.instance.trim().length === 0) {
        throw invalidArguments(`${toolName} requires instance.`);
    }
    return input.instance.trim();
}

function readSshCreateInput(input: JsonValue): McpSshInstanceCreateInput {
    if (!isRecord(input)) {
        throw invalidArguments("instance_create requires an object input.");
    }
    const name = requiredString(input.name, "name");
    const host = requiredString(input.host, "host");
    const workspace = requiredString(input.workspace, "workspace");
    const user = optionalString(input.user, "user");
    const identityFile = optionalString(input.identityFile, "identityFile");
    const port = input.port;
    if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
        throw invalidArguments("port must be an integer between 1 and 65535.");
    }
    return {
        host,
        identityFile,
        name,
        port: port as number | undefined,
        user,
        workspace
    };
}

function requiredString(value: JsonValue | undefined, field: string): string {
    const normalized = optionalString(value, field);
    if (normalized === undefined) {
        throw invalidArguments(`${field} is required.`);
    }
    return normalized;
}

function optionalString(value: JsonValue | undefined, field: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        throw invalidArguments(`${field} must be a non-empty string.`);
    }
    return value.trim();
}

function invalidArguments(message: string) {
    return createError({
        code: errorCodes.targetInvalid,
        message,
        retryable: false
    });
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw cancellationError(signal.reason);
    }
}

async function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    throwIfAborted(signal);
    if (signal === undefined) {
        return await operation;
    }

    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(cancellationError(signal.reason));
        signal.addEventListener("abort", onAbort, { once: true });
        void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

function cancellationError(reason: unknown) {
    return createError({
        code: errorCodes.coreToolCallCancelled,
        cause: reason,
        message: "MCP tool call was cancelled by the client.",
        retryable: true,
        details: {
            reason: typeof reason === "string" ? reason : "client cancelled"
        }
    });
}
