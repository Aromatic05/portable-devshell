import { createError, errorCodes, toolSchema, type ToolDefinition } from "@portable-devshell/shared";

import type { WorkerToolDefinition } from "../../worker/protocol/WorkerProtocolClient.js";
import { ToolAllowlist } from "../../tool/ToolAllowlist.js";

export class WorkerToolCatalog {
    readonly #allowlist: ToolAllowlist;
    #hasSchema = false;
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
                    code: errorCodes.coreToolSchemaUnavailable,
                    message: `Worker tool catalog is incompatible: ${tool.name} has an invalid schema. Upgrade and restart the Worker to match this portable-devshell version.`,
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
