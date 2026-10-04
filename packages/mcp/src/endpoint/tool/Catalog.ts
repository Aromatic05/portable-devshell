import {
    bootstrapToolNamespace,
    toolNamespace,
    type JsonValue,
    type ToolDefinition,
} from "@portable-devshell/shared";

import type { McpAuthConfig } from "../../auth/Config.js";
import {
    createMcpContextSelector,
    type McpContextSelector,
} from "../../context/Selector.js";
import {
    mcpToolAnnotations,
    mcpToolPreserveInputDescriptions,
    McpToolDescriptionEnhancer,
    mcpToolInvocationStatus,
    mcpToolTitle,
} from "./Metadata.js";
import {
    McpToolSchemaAdapter,
    withMcpCommentOutputSchema,
    type McpTool,
} from "./Schema.js";
import {
    withMcpContextId,
    withMcpInstanceTarget,
    withMcpProvenance,
} from "./Input.js";
import {
    mcpTools,
    type McpToolRegistry,
    type McpToolRegistryEntry,
} from "./Registry.js";

export interface McpEndpointCatalogOptions {
    auth?: McpAuthConfig;
    contextSelector?: McpContextSelector;
    bootstrapPresentationResourceUri?: string;
    instanceName: string;
    instanceRoutingEnabled?: boolean;
    registry?: McpToolRegistry;
}

export interface McpEndpointCatalogSnapshot {
    entries: readonly McpToolRegistryEntry[];
    instanceRoutingEnabled: boolean;
}

export class McpEndpointCatalog {
    readonly #auth: McpAuthConfig;
    readonly #bootstrapPresentationResourceUri?: string;
    readonly #contextSelector: McpContextSelector;
    readonly #descriptionEnhancer = new McpToolDescriptionEnhancer();
    readonly #instanceName: string;
    readonly #instanceRoutingEnabled: boolean;
    readonly #registry: McpToolRegistry;
    readonly #schemaAdapter = new McpToolSchemaAdapter();

    constructor(options: McpEndpointCatalogOptions) {
        this.#auth = options.auth ?? { enabled: false, provider: "none" };
        this.#bootstrapPresentationResourceUri =
            options.bootstrapPresentationResourceUri;
        this.#contextSelector =
            options.contextSelector ?? createMcpContextSelector("explicit");
        this.#instanceName = options.instanceName;
        this.#instanceRoutingEnabled = options.instanceRoutingEnabled === true;
        this.#registry = options.registry ?? mcpTools;
    }

    snapshot(): McpEndpointCatalogSnapshot {
        return {
            entries: this.#registry.list(this.#instanceName),
            instanceRoutingEnabled: this.#instanceRoutingEnabled,
        };
    }

    listTools(): McpTool[] {
        const snapshot = this.snapshot();
        return snapshot.entries.map((entry) =>
            this.adapt(this.#withRoutingTarget(entry, snapshot.instanceRoutingEnabled)),
        );
    }

    getTool(
        toolName: string,
        instanceName: string = this.#instanceName,
    ): ToolDefinition | undefined {
        return this.#registry.get(instanceName, toolName)?.definition;
    }

    getEntry(toolName: string): McpToolRegistryEntry | undefined {
        return this.#registry.get(this.#instanceName, toolName);
    }

    adapt(tool: ToolDefinition): McpTool {
        const modelTool = withBootstrapPresentation(
            hideInternalWorkerInput(tool),
            this.#bootstrapPresentationResourceUri,
        );
        const provenanceTool =
            isBootstrapTool(modelTool.name) || !isModelFacingTool(modelTool)
                ? modelTool
                : withMcpProvenance(modelTool);
        const modelFacing = isModelFacingTool(provenanceTool);
        const contextualTool =
            this.#contextSelector.requiresExplicitContextId || !modelFacing
                ? withMcpContextId(
                      provenanceTool,
                      modelFacing
                          ? undefined
                          : "Internal Context ID carried by the MCP App.",
                  )
                : provenanceTool;
        const exposed = isBootstrapTool(contextualTool.name)
            ? contextualTool
            : withMcpCommentOutputSchema(contextualTool);
        const adapted = this.#schemaAdapter.toMcpTool(
            exposed,
            this.#descriptionEnhancer.enhance(
                exposed.name,
                exposed.description,
                exposed._meta,
            ),
            {
                modelFacing,
                preserveInputDescriptions:
                    mcpToolPreserveInputDescriptions(exposed._meta),
            },
        );
        const securitySchemes = mcpToolSecuritySchemes(this.#auth);
        const invocationStatus = mcpToolInvocationStatus(
            exposed.name,
            exposed._meta,
        );
        const meta = {
            ...asRecord(adapted._meta),
            ...(invocationStatus === undefined
                ? {}
                : {
                      "openai/toolInvocation/invoked": invocationStatus.invoked,
                      "openai/toolInvocation/invoking":
                          invocationStatus.invoking,
                  }),
            ...(securitySchemes === undefined ? {} : { securitySchemes }),
        };
        return {
            ...adapted,
            ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }),
            ...(securitySchemes === undefined ? {} : { securitySchemes }),
            annotations: mcpToolAnnotations(exposed.name, exposed._meta),
            title: mcpToolTitle(exposed.name, exposed._meta),
        };
    }

    assertAdaptable(tool: ToolDefinition): void {
        this.adapt(tool);
    }

    #withRoutingTarget(
        entry: McpToolRegistryEntry,
        instanceRoutingEnabled: boolean,
    ): ToolDefinition {
        return instanceRoutingEnabled && entry.scope !== "*"
            ? withMcpInstanceTarget(entry.definition)
            : entry.definition;
    }
}

function isBootstrapTool(name: string): boolean {
    return toolNamespace(name) === bootstrapToolNamespace;
}

function withBootstrapPresentation(
    tool: ToolDefinition,
    resourceUri: string | undefined,
): ToolDefinition {
    if (resourceUri === undefined || tool.name !== `${bootstrapToolNamespace}_info`)
        return tool;
    return {
        ...tool,
        _meta: {
            ...asRecord(tool._meta),
            ui: {
                ...asRecord(asRecord(tool._meta).ui),
                resourceUri,
                visibility: ["model", "app"],
            },
            "ui/resourceUri": resourceUri,
            "openai/outputTemplate": resourceUri,
            "openai/widgetAccessible": true,
        },
    };
}

function hideInternalWorkerInput(tool: ToolDefinition): ToolDefinition {
    if (tool.name !== "tmux_run" && tool.name !== "tmux_read") return tool;
    const inputSchema = asRecord(tool.inputSchema);
    const properties = { ...asRecord(inputSchema.properties) };
    if (!("consumeOutput" in properties)) return tool;
    delete properties.consumeOutput;
    return {
        ...tool,
        inputSchema: {
            ...inputSchema,
            properties,
        },
    };
}

function mcpToolSecuritySchemes(auth: McpAuthConfig): JsonValue[] | undefined {
    if (auth.provider === "none") return [{ type: "noauth" }];
    if (auth.provider === "oauth2") {
        return [{ type: "oauth2", scopes: [...auth.oauth2.requiredScopes] }];
    }
    return undefined;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : {};
}

function isModelFacingTool(tool: ToolDefinition): boolean {
    const visibility = asRecord(asRecord(tool._meta).ui).visibility;
    return (
        !Array.isArray(visibility) ||
        visibility.some((entry) => entry === "model")
    );
}
