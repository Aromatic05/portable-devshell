import {
    bootstrapToolNamespace,
    createError,
    errorCodes,
    toolNamespace,
    type ToolDefinition
} from "@portable-devshell/shared";

export type McpToolCatalogEndpointOwner = "worker" | "artifact" | "environment" | "workspace" | "todo";

export interface McpToolCatalogEndpointEntry {
    definition: ToolDefinition;
    owner: McpToolCatalogEndpointOwner;
}

export interface McpToolCatalogEndpointSource {
    owner: McpToolCatalogEndpointOwner;
    tools: readonly ToolDefinition[];
}

export class McpToolCatalogEndpoint {
    merge(sources: readonly McpToolCatalogEndpointSource[]): McpToolCatalogEndpointEntry[] {
        const merged = new Map<string, McpToolCatalogEndpointEntry>();

        for (const source of sources) {
            for (const definition of source.tools) {
                const namespace = toolNamespace(definition.name);
                if (namespace === undefined || definition.group !== namespace) {
                    throw createError({
                        code: errorCodes.coreToolSchemaUnavailable,
                        details: {
                            group: definition.group,
                            namespace: namespace ?? null,
                            owner: source.owner,
                            toolName: definition.name
                        },
                        message: `Tool ${definition.name} group ${definition.group} must match its namespace.`,
                        retryable: false
                    });
                }
                if (namespace === bootstrapToolNamespace && source.owner !== "environment") {
                    throw createError({
                        code: errorCodes.coreToolSchemaUnavailable,
                        details: {
                            owner: source.owner,
                            toolName: definition.name
                        },
                        message: `Tool namespace ${bootstrapToolNamespace} is reserved for the environment bootstrap owner.`,
                        retryable: false
                    });
                }
                if (source.owner === "environment" && namespace !== bootstrapToolNamespace) {
                    throw createError({
                        code: errorCodes.coreToolSchemaUnavailable,
                        details: {
                            namespace,
                            toolName: definition.name
                        },
                        message: `Environment bootstrap owner may only define ${bootstrapToolNamespace}_* tools.`,
                        retryable: false
                    });
                }
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
}
