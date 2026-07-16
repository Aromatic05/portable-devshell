import {
    createError,
    errorCodes,
    type ToolDefinition,
    type ToolPolicy
} from "@portable-devshell/shared";

import { McpToolFilter } from "../McpToolFilter.js";

export type McpToolCatalogEndpointOwner = "worker" | "artifact" | "environment" | "instance" | "todo";

export interface McpToolCatalogEndpointEntry {
    definition: ToolDefinition;
    owner: McpToolCatalogEndpointOwner;
}

export interface McpToolCatalogEndpointSource {
    owner: McpToolCatalogEndpointOwner;
    tools: readonly ToolDefinition[];
}

export class McpToolCatalogEndpoint {
    readonly #filter: McpToolFilter;

    constructor(policy: ToolPolicy) {
        this.#filter = new McpToolFilter(policy);
    }

    merge(sources: readonly McpToolCatalogEndpointSource[]): McpToolCatalogEndpointEntry[] {
        const merged = new Map<string, McpToolCatalogEndpointEntry>();

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

    filter(entries: readonly McpToolCatalogEndpointEntry[]): McpToolCatalogEndpointEntry[] {
        return entries.filter((entry) => entry.owner === "environment" || this.#filter.isAllowed(entry.definition));
    }

    isAllowed(tool: ToolDefinition): boolean {
        return this.#filter.isAllowed(tool);
    }
}
