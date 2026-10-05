import {
    createRemoteError,
    runtimeErrorCodes,
    toolSchema,
    type ToolDefinition,
} from "@portable-devshell/shared";

export class WorkerToolCatalog {
    #hasSchema = false;
    #tools = new Map<string, ToolDefinition>();

    refresh(tools: readonly ToolDefinition[]): ToolDefinition[] {
        const nextTools = new Map<string, ToolDefinition>();

        for (const tool of tools) {
            const parsed = toolSchema.safeParse(tool);

            if (!parsed.success) {
                throw createRemoteError({
                    code: runtimeErrorCodes.toolSchemaUnavailable,
                    message: `Worker tool catalog is incompatible: ${tool.name} has an invalid schema. Upgrade and restart the Worker to match this portable-devshell version.`,
                    retryable: false,
                    details: {
                        toolName: tool.name,
                        reason: parsed.error.message,
                    },
                });
            }

            nextTools.set(parsed.data.name, parsed.data);
        }

        this.#tools = nextTools;
        this.#hasSchema = true;
        return this.listTools();
    }

    clear(): void {
        this.#tools.clear();
        this.#hasSchema = false;
    }

    hasSchema(): boolean {
        return this.#hasSchema;
    }

    listTools(): ToolDefinition[] {
        return [...this.#tools.values()];
    }

    getTool(name: string): ToolDefinition | undefined {
        return this.#tools.get(name);
    }
}
