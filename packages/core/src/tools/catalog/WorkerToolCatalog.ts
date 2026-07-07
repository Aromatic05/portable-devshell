import { createError, errorCodes, toolSchema, type ToolDefinition } from "@portable-devshell/shared";

import type { WorkerToolDefinition } from "../../worker/protocol/WorkerProtocolClient.js";
import { ToolAllowlist } from "../policy/ToolAllowlist.js";

export class WorkerToolCatalog {
    readonly #allowlist: ToolAllowlist;
    #tools = new Map<string, ToolDefinition>();

    constructor(allowlist: ToolAllowlist) {
        this.#allowlist = allowlist;
    }

    refresh(tools: readonly WorkerToolDefinition[]): ToolDefinition[] {
        const filteredTools = this.#allowlist.filter(tools);
        const nextTools = new Map<string, ToolDefinition>();

        for (const tool of filteredTools) {
            const parsed = toolSchema.safeParse(tool);

            if (!parsed.success) {
                throw createError({
                    code: errorCodes.toolSchemaInvalid,
                    message: `Tool schema for ${tool.name} is invalid.`,
                    retryable: false,
                    details: {
                        toolName: tool.name,
                        reason: parsed.error.message
                    }
                });
            }

            nextTools.set(parsed.data.name, parsed.data);
        }

        this.#tools = nextTools;
        return this.listTools();
    }

    clear(): void {
        this.#tools.clear();
    }

    listTools(): ToolDefinition[] {
        return [...this.#tools.values()];
    }

    getTool(name: string): ToolDefinition | undefined {
        return this.#tools.get(name);
    }
}
