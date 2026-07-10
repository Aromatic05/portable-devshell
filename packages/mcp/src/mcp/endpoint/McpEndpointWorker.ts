import { createError, errorCodes, type JsonValue, type ToolCallContext, type ToolDefinition } from "@portable-devshell/shared";

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
    readonly #instanceName: string;
    readonly #schemaAdapter: McpToolSchemaAdapter;
    readonly #worker: WorkerInstanceLike;

    constructor(options: { allowlist: readonly string[]; instanceName: string; worker: WorkerInstanceLike }) {
        this.#descriptionEnhancer = new McpToolDescriptionEnhancer();
        this.#filter = new McpToolFilter(options.allowlist);
        this.#instanceName = options.instanceName;
        this.#schemaAdapter = new McpToolSchemaAdapter();
        this.#worker = options.worker;
    }

    get instanceName(): string {
        return this.#instanceName;
    }

    assertReady(): void {
        if (!this.#worker.snapshot().ready) {
            throw createError({
                code: errorCodes.coreInstanceNotReady,
                details: { instance: this.#instanceName },
                message: `Instance ${this.#instanceName} is not ready.`,
                retryable: false
            });
        }
    }

    listTools(): McpTool[] {
        if (!this.#worker.snapshot().ready && this.#worker.hasToolSchemaCache?.() !== true) {
            throw new McpToolSchemaUnavailableError(this.#instanceName);
        }

        return this.#filter.filter(this.#worker.listTools()).map((tool) => this.#adaptTool(tool));
    }

    getTool(toolName: string): ToolDefinition | undefined {
        return this.#filter.filter(this.#worker.listTools()).find((tool) => tool.name === toolName);
    }

    async appendSessionOpened(sessionId: string): Promise<void> {
        await this.#worker.appendMcpSessionOpened(sessionId);
    }

    async appendSessionClosed(sessionId: string): Promise<void> {
        await this.#worker.appendMcpSessionClosed(sessionId);
    }

    async callTool(toolName: string, input: JsonValue, context: ToolCallContext) {
        await this.#worker.appendMcpToolCalled(toolName, {
            requestId: context.requestId,
            sessionId: context.sessionId
        });
        this.assertReady();
        const tool = this.getTool(toolName);

        if (tool === undefined) {
            throw createError({
                code: errorCodes.coreToolSchemaUnavailable,
                details: { instance: this.#instanceName, toolName },
                message: `Tool ${toolName} is not exposed by MCP.`,
                retryable: false
            });
        }

        this.#adaptTool(tool);
        return await this.#worker.callTool(toolName, input, context);
    }

    #adaptTool(tool: ToolDefinition): McpTool {
        return this.#schemaAdapter.toMcpTool(tool, this.#descriptionEnhancer.enhance(tool.description));
    }
}
