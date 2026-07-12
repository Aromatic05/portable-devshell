import {
    createError,
    errorCodes,
    type ToolDefinition,
    type ToolPolicy
} from "@portable-devshell/shared";

import { McpToolFilter } from "../tool/McpToolFilter.js";

export type McpEndpointToolOwner = "worker" | "instance" | "todo";

export interface McpEndpointToolEntry {
    definition: ToolDefinition;
    owner: McpEndpointToolOwner;
}

export interface McpEndpointToolSource {
    owner: McpEndpointToolOwner;
    tools: readonly ToolDefinition[];
}

export class McpEndpointToolCatalog {
    readonly #filter: McpToolFilter;

    constructor(policy: ToolPolicy) {
        this.#filter = new McpToolFilter(policy);
    }

    merge(sources: readonly McpEndpointToolSource[]): McpEndpointToolEntry[] {
        const merged = new Map<string, McpEndpointToolEntry>();

        for (const source of sources) {
            for (const definition of source.tools) {
                const previous = merged.get(definition.name);
                if (previous !== undefined) {
                    throw createError({
                        code: errorCodes.coreToolSchemaUnavailable,
                        details: {
                            firstOwner: previous.owner,
                            secondOwner: source.owner,
                            toolName: definition.name
                        },
                        message: `Tool ${definition.name} is defined by both ${previous.owner} and ${source.owner}.`,
                        retryable: false
                    });
                }
                merged.set(definition.name, {
                    definition,
                    owner: source.owner
                });
            }
        }

        return [...merged.values()];
    }

    filter(entries: readonly McpEndpointToolEntry[]): McpEndpointToolEntry[] {
        return entries.filter((entry) => this.#filter.isAllowed(entry.definition));
    }

    isAllowed(tool: ToolDefinition): boolean {
        return this.#filter.isAllowed(tool);
    }
}
