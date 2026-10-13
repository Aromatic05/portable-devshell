import {
    bootstrapToolNamespace,
    toolNamespace,
    type JsonValue,
    type ToolDefinition,
} from "@portable-devshell/shared";

import type { McpAuthConfig } from "../../oauth/Config.js";
import {
    createMcpContextSelector,
    type McpContextSelector,
} from "../context/Selector.js";
import {
    mcpToolAnnotations,
    mcpToolHiddenInputProperties,
    mcpToolInputHints,
    mcpToolPreserveInputDescriptions,
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
import type {
    McpToolSource,
    McpToolSourceEntry,
} from "./Source.js";

export interface McpEndpointCatalogOptions {
    auth?: McpAuthConfig;
    contextSelector?: McpContextSelector;
    bootstrapPresentationResourceUri?: string;
    interactionPresentationResourceUri?: string;
    toolCallPresentationResourceUri?: string;
    toolCallPresentationResourceUriForTool?: (toolName: string) => string;
    instanceName: string;
    instanceRoutingEnabled?: boolean;
    source: McpToolSource;
}

export interface McpEndpointCatalogSnapshot {
    entries: readonly McpToolSourceEntry[];
    instanceRoutingEnabled: boolean;
}

export class McpEndpointCatalog {
    readonly #auth: McpAuthConfig;
    readonly #bootstrapPresentationResourceUri?: string;
    readonly #interactionPresentationResourceUri?: string;
    readonly #toolCallPresentationResourceUri?: string;
    readonly #toolCallPresentationResourceUriForTool?: (toolName: string) => string;
    readonly #contextSelector: McpContextSelector;
    readonly #instanceName: string;
    readonly #instanceRoutingEnabled: boolean;
    readonly #source: McpToolSource;
    readonly #schemaAdapter = new McpToolSchemaAdapter();

    constructor(options: McpEndpointCatalogOptions) {
        this.#auth = options.auth ?? { enabled: false, provider: "none" };
        this.#bootstrapPresentationResourceUri =
            options.bootstrapPresentationResourceUri;
        this.#interactionPresentationResourceUri =
            options.interactionPresentationResourceUri;
        this.#toolCallPresentationResourceUri = options.toolCallPresentationResourceUri;
        this.#toolCallPresentationResourceUriForTool = options.toolCallPresentationResourceUriForTool;
        this.#contextSelector =
            options.contextSelector ?? createMcpContextSelector("explicit");
        this.#instanceName = options.instanceName;
        this.#instanceRoutingEnabled = options.instanceRoutingEnabled === true;
        this.#source = options.source;
    }

    snapshot(): McpEndpointCatalogSnapshot {
        return {
            entries: this.#source.list(this.#instanceName),
            instanceRoutingEnabled: this.#instanceRoutingEnabled,
        };
    }

    listTools(): McpTool[] {
        const snapshot = this.snapshot();
        return snapshot.entries.map((entry) =>
            this.adapt(
                this.#withRoutingTarget(entry, snapshot.instanceRoutingEnabled),
            ),
        );
    }

    getTool(
        toolName: string,
        instanceName: string = this.#instanceName,
    ): ToolDefinition | undefined {
        return this.#source.get(instanceName, toolName)?.definition;
    }

    getEntry(toolName: string): McpToolSourceEntry | undefined {
        return this.#source.get(this.#instanceName, toolName);
    }

    adapt(tool: ToolDefinition): McpTool {
        const modelTool = withBootstrapPresentation(
            tool,
            this.#bootstrapPresentationResourceUri,
            this.#interactionPresentationResourceUri,
            this.#toolCallPresentationResourceUri,
            this.#toolCallPresentationResourceUriForTool,
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
            exposed.description.trim(),
            {
                hiddenInputProperties: mcpToolHiddenInputProperties(
                    exposed._meta,
                ),
                inputHints: mcpToolInputHints(exposed._meta),
                modelFacing,
                preserveInputDescriptions: mcpToolPreserveInputDescriptions(
                    exposed._meta,
                ),
            },
        );
        const securitySchemes = mcpToolSecuritySchemes(this.#auth);
        const invocationStatus = mcpToolInvocationStatus(exposed._meta);
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
            annotations: mcpToolAnnotations(exposed._meta),
            title: mcpToolTitle(exposed.name, exposed._meta),
        };
    }

    assertAdaptable(tool: ToolDefinition): void {
        this.adapt(tool);
    }

    #withRoutingTarget(
        entry: McpToolSourceEntry,
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
    workspaceResourceUri: string | undefined,
    interactionResourceUri: string | undefined,
    toolCallResourceUri: string | undefined,
    toolCallResourceUriForTool: ((toolName: string) => string) | undefined,
): ToolDefinition {
    if (!isModelFacingTool(tool)) return tool;
    // tmux_read is a background transcript poll. Its output belongs to the
    // tmux_run task terminal, not an additional Inline widget on every poll.
    // The ToolCall itself remains fully audited and available in Workspace.
    if (tool.name === "tmux_read") return tool;
    const meta = asRecord(tool._meta);
    const ui = asRecord(meta.ui);
    // A tool's own MCP App binding always takes precedence.
    if (typeof ui.resourceUri === "string" || typeof meta["openai/outputTemplate"] === "string")
        return tool;
    const resourceUri = tool.name === "mcpapp_open" ? workspaceResourceUri
        : tool.name === "mcpapp_ask" ? interactionResourceUri
        : toolCallResourceUriForTool?.(tool.name) ?? toolCallResourceUri ??
            (tool.name === `${bootstrapToolNamespace}_info` ? workspaceResourceUri : undefined);
    if (resourceUri === undefined) return tool;
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
            ...(tool.name === "mcpapp_open" || tool.name === "mcpapp_ask"
                ? { "openai/widgetAccessible": true } : {}),
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
