import type { ToolCallContext } from "@portable-devshell/shared";

import { McpToolDescriptionEnhancer } from "../tool/McpToolDescriptionEnhancer.js";
import { McpToolFilter } from "../tool/McpToolFilter.js";
import { McpToolSchemaAdapter, McpToolSchemaUnavailableError, type McpTool } from "../tool/McpToolSchemaAdapter.js";

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

interface ToolDefinition {
    description?: string;
    inputSchema?: JsonValue;
    name: string;
}

interface CommandResult {
    exitCode: number | null;
    stderr: string;
    stdout: string;
    timedOut?: boolean;
}

interface WorkerInstanceLike {
    callTool(toolName: string, input: JsonValue, context: ToolCallContext): Promise<CommandResult>;
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
            const error = new Error(`Instance ${this.#instanceName} is not ready.`);
            Object.assign(error, {
                code: "core.instanceNotReady",
                details: { instanceName: this.#instanceName },
                retryable: false
            });
            throw error;
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

    async callTool(toolName: string, input: JsonValue, context: ToolCallContext) {
        this.assertReady();
        const tool = this.getTool(toolName);

        if (tool === undefined) {
            throw new Error(`Tool ${toolName} is not exposed by MCP.`);
        }

        this.#adaptTool(tool);
        return await this.#worker.callTool(toolName, input, context);
    }

    #adaptTool(tool: ToolDefinition): McpTool {
        return this.#schemaAdapter.toMcpTool(tool, this.#descriptionEnhancer.enhance(tool.description));
    }
}
