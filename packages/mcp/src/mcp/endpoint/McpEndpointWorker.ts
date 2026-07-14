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
    appendMcpSessionClosed(sessionId: string): Promise<void>;
    appendMcpSessionOpened(sessionId: string): Promise<void>;
    appendMcpToolCalled(toolName: string, context: { requestId?: string; sessionId?: string }): Promise<void>;
    callTool(toolName: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue>;
    hasToolSchemaCache?(): boolean;
    listTools(): ToolDefinition[];
    snapshot(): { ready?: boolean };
}

export class McpEndpointWorker {
    readonly #artifactTools = new McpArtifactToolCatalog();
    readonly #catalog: McpEndpointToolCatalog;
    readonly #descriptionEnhancer = new McpToolDescriptionEnhancer();
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #instanceTools = new McpInstanceToolCatalog();
    readonly #schemaAdapter = new McpToolSchemaAdapter();
    readonly #todoTools = new McpTodoToolCatalog();
    readonly #worker: WorkerInstanceLike;

    constructor(options: {
        gateway?: McpInstanceGateway;
        instanceName: string;
        policy: ToolPolicy;
        worker: WorkerInstanceLike;
    }) {
        this.#catalog = new McpEndpointToolCatalog(options.policy);
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
                entry.owner === "worker" && instanceRoutingEnabled
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
        await this.#gateway?.closeToolSession?.(sessionId);
    }

    async callTool(toolName: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        await this.#worker.appendMcpToolCalled(toolName, {
            requestId: context.requestId,
            sessionId: context.sessionId
        });

        const { merged, exposed } = this.#resolveCatalog();
        const known = merged.find((entry) => entry.definition.name === toolName);
        const selected = exposed.find((entry) => entry.definition.name === toolName);

        if (known?.owner === "todo") {
            if (selected === undefined) {
                throw this.#toolNotExposed(toolName);
            }
            this.#adaptTool(selected.definition);
            return await this.#callTodoTool(toolName as McpTodoToolName, input, context);
        }

        if (known?.owner === "artifact") {
            if (selected === undefined) {
                throw this.#toolNotExposed(toolName);
            }
            this.#adaptTool(selected.definition);
            return await this.#callArtifactTool(toolName as McpArtifactToolName, input);
        }

        if (known?.owner === "instance") {
            if (selected === undefined) {
                throw this.#toolNotExposed(toolName);
            }
            this.#adaptTool(selected.definition);
            return await this.#callInstanceTool(toolName as McpInstanceToolName, input);
        }

        const instanceRoutingEnabled = exposed.some((entry) => entry.owner === "instance");
        const routed = readRoutedInput(input, instanceRoutingEnabled, this.#instanceName);

        if (routed.instance === this.#instanceName) {
            this.assertReady();
            if (selected === undefined || selected.owner !== "worker") {
                throw this.#toolNotExposed(toolName);
            }
            this.#adaptTool(selected.definition);
            return await this.#worker.callTool(toolName, routed.input, context);
        }

        const gateway = this.#requireGateway();
        gateway.assertReady(routed.instance);
        const targetTool = gateway.listTools(routed.instance).find((tool) => tool.name === toolName);
        if (targetTool === undefined || !this.#catalog.isAllowed(targetTool)) {
            throw this.#toolNotExposed(toolName, routed.instance);
        }
        this.#adaptTool(targetTool);
        return await gateway.callTool(routed.instance, toolName, routed.input, context);
    }

    #resolveCatalog(): {
        exposed: McpEndpointToolEntry[];
        hasWorkerSchema: boolean;
        merged: McpEndpointToolEntry[];
    } {
        const hasWorkerSchema = this.#worker.snapshot().ready || this.#worker.hasToolSchemaCache?.() === true;
        const sources: McpEndpointToolSource[] = [];

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

    async #callArtifactTool(toolName: McpArtifactToolName, input: JsonValue): Promise<JsonValue> {
        const gateway = this.#requireGateway();
        switch (toolName) {
            case "artifact_share":
                if (gateway.shareArtifact === undefined) {
                    throw this.#toolNotExposed(toolName);
                }
                return await gateway.shareArtifact(this.#instanceName, readArtifactShareInput(input));
            case "artifact_transfer":
                if (gateway.transferArtifact === undefined) {
                    throw this.#toolNotExposed(toolName);
                }
                return await gateway.transferArtifact(this.#instanceName, readArtifactTransferInput(input));
        }
    }

    async #callTodoTool(toolName: McpTodoToolName, input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        const gateway = this.#requireGateway();
        switch (toolName) {
            case "todo_read":
                assertNoArguments(input, toolName);
                return await gateway.readTodo(this.#instanceName);
            case "todo_write":
                return await gateway.writeTodo(this.#instanceName, input, context);
        }
    }

    async #callInstanceTool(toolName: McpInstanceToolName, input: JsonValue): Promise<JsonValue> {
        const gateway = this.#requireGateway();
        switch (toolName) {
            case "instance_list":
                assertNoArguments(input, toolName);
                return { instances: await gateway.listInstances() };
            case "instance_status":
                return await gateway.statusInstance(readInstanceName(input, toolName));
            case "instance_start":
                return await gateway.startInstance(readInstanceName(input, toolName));
            case "instance_stop":
                return await gateway.stopInstance(readInstanceName(input, toolName));
            case "instance_create":
                return await gateway.createSshInstance(this.#instanceName, readSshCreateInput(input));
        }
    }

    #adaptTool(tool: ToolDefinition): McpTool {
        return this.#schemaAdapter.toMcpTool(tool, this.#descriptionEnhancer.enhance(tool.description));
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

function withInstanceTarget(tool: ToolDefinition): ToolDefinition {
    if (!isRecord(tool.inputSchema)) {
        throw new McpToolSchemaUnavailableError(tool.name);
    }
    const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
    return {
        ...tool,
        description: `${tool.description} Set instance to route the call to another managed instance; omit it to use the current instance.`,
        inputSchema: {
            ...tool.inputSchema,
            properties: {
                ...properties,
                instance: {
                    description: "Optional target portable-devshell instance. Defaults to the current endpoint instance.",
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
