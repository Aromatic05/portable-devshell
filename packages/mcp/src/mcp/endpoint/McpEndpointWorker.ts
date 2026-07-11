import {
    createError,
    errorCodes,
    type JsonValue,
    type ToolCallContext,
    type ToolDefinition,
    type ToolPolicy
} from "@portable-devshell/shared";

import type { McpInstanceGateway, McpSshInstanceCreateInput } from "../instance/McpInstanceGateway.js";
import { McpInstanceToolCatalog, type McpInstanceToolName } from "../instance/McpInstanceToolCatalog.js";
import { McpToolDescriptionEnhancer } from "../tool/McpToolDescriptionEnhancer.js";
import { McpToolFilter } from "../tool/McpToolFilter.js";
import { McpToolSchemaAdapter, McpToolSchemaUnavailableError, type McpTool } from "../tool/McpToolSchemaAdapter.js";

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
    readonly #descriptionEnhancer: McpToolDescriptionEnhancer;
    readonly #filter: McpToolFilter;
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #instanceTools = new McpInstanceToolCatalog();
    readonly #managementEnabled: boolean;
    readonly #schemaAdapter: McpToolSchemaAdapter;
    readonly #worker: WorkerInstanceLike;

    constructor(options: {
        gateway?: McpInstanceGateway;
        instanceName: string;
        policy: ToolPolicy;
        worker: WorkerInstanceLike;
    }) {
        this.#descriptionEnhancer = new McpToolDescriptionEnhancer();
        this.#filter = new McpToolFilter(options.policy);
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#managementEnabled =
            options.gateway !== undefined &&
            options.policy.groups.includes("instance") &&
            options.policy.capabilities.includes("manage");
        this.#schemaAdapter = new McpToolSchemaAdapter();
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
        const managementTools = this.#managementEnabled
            ? this.#instanceTools.list().filter((tool) => this.#filter.isAllowed(tool)).map((tool) => this.#adaptTool(tool))
            : [];
        const hasWorkerSchema = this.#worker.snapshot().ready || this.#worker.hasToolSchemaCache?.() === true;

        if (!hasWorkerSchema) {
            if (managementTools.length > 0) {
                return managementTools;
            }
            throw new McpToolSchemaUnavailableError(this.#instanceName);
        }

        const workerTools = this.#filter
            .filter(this.#worker.listTools())
            .map((tool) => this.#adaptTool(this.#managementEnabled ? withInstanceTarget(tool) : tool));
        return [...workerTools, ...managementTools];
    }

    getTool(toolName: string): ToolDefinition | undefined {
        const managementTool = this.#managementEnabled ? this.#instanceTools.get(toolName) : undefined;
        if (managementTool !== undefined && this.#filter.isAllowed(managementTool)) {
            return managementTool;
        }
        return this.#filter.filter(this.#worker.listTools()).find((tool) => tool.name === toolName);
    }

    async appendSessionOpened(sessionId: string): Promise<void> {
        await this.#worker.appendMcpSessionOpened(sessionId);
    }

    async appendSessionClosed(sessionId: string): Promise<void> {
        await this.#worker.appendMcpSessionClosed(sessionId);
    }

    async callTool(toolName: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue> {
        await this.#worker.appendMcpToolCalled(toolName, {
            requestId: context.requestId,
            sessionId: context.sessionId
        });

        if (this.#managementEnabled && this.#instanceTools.isInstanceTool(toolName)) {
            const tool = this.#instanceTools.get(toolName)!;
            if (!this.#filter.isAllowed(tool)) {
                throw this.#toolNotExposed(toolName);
            }
            this.#adaptTool(tool);
            return await this.#callInstanceTool(toolName, input);
        }

        const routed = readRoutedInput(input, this.#managementEnabled, this.#instanceName);
        if (routed.instance === this.#instanceName) {
            this.assertReady();
            const tool = this.getTool(toolName);
            if (tool === undefined || this.#instanceTools.isInstanceTool(toolName)) {
                throw this.#toolNotExposed(toolName);
            }
            this.#adaptTool(tool);
            return await this.#worker.callTool(toolName, routed.input, context);
        }

        const gateway = this.#requireGateway();
        const targetTool = gateway.listTools(routed.instance).find((tool) => tool.name === toolName);
        if (targetTool === undefined || !this.#filter.isAllowed(targetTool)) {
            throw this.#toolNotExposed(toolName, routed.instance);
        }
        this.#adaptTool(targetTool);
        return await gateway.callTool(routed.instance, toolName, routed.input, context);
    }

    async #callInstanceTool(toolName: McpInstanceToolName, input: JsonValue): Promise<JsonValue> {
        const gateway = this.#requireGateway();
        switch (toolName) {
            case "instance_list":
                assertNoArguments(input, toolName);
                return await gateway.listInstances();
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
        if (this.#gateway !== undefined && this.#managementEnabled) {
            return this.#gateway;
        }
        throw createError({
            code: errorCodes.coreToolSchemaUnavailable,
            details: { instance: this.#instanceName },
            message: `Instance management is not exposed by ${this.#instanceName}.`,
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

function readRoutedInput(input: JsonValue, managementEnabled: boolean, defaultInstance: string): { input: JsonValue; instance: string } {
    if (!isRecord(input)) {
        return { input, instance: defaultInstance };
    }
    const target = input.instance;
    if (target === undefined) {
        return { input, instance: defaultInstance };
    }
    if (!managementEnabled) {
        throw invalidArguments("The instance argument is only available when instance management is enabled.");
    }
    if (typeof target !== "string" || target.trim().length === 0) {
        throw invalidArguments("instance must be a non-empty string.");
    }
    const { instance: _ignored, ...workerInput } = input;
    return { input: workerInput, instance: target.trim() };
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
