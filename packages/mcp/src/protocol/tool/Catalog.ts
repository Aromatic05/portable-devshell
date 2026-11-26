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
    statelessCwdHint,
    withMcpContextId,
    withMcpInstanceTarget,
    withMcpProvenance,
    withStatelessCwd,
} from "./Input.js";
import type {
    McpToolSource,
    McpToolSourceEntry,
} from "./Source.js";

export interface McpEndpointCatalogOptions {
    auth?: McpAuthConfig;
    appEnabled?: boolean | (() => boolean);
    contextSelector?: McpContextSelector;
    bootstrapPresentationResourceUri?: string;
    toolCallPresentationResourceUri?: string;
    toolCallPresentationResourceUriForTool?: (toolName: string) => string | undefined;
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
    readonly #toolCallPresentationResourceUri?: string;
    readonly #toolCallPresentationResourceUriForTool?: (toolName: string) => string | undefined;
    readonly #contextSelector: McpContextSelector;
    readonly #instanceName: string;
    readonly #instanceRoutingEnabled: boolean;
    readonly #source: McpToolSource;
    readonly #appEnabled: () => boolean;
    readonly #schemaAdapter = new McpToolSchemaAdapter();

    constructor(options: McpEndpointCatalogOptions) {
        this.#auth = options.auth ?? { enabled: false, provider: "none" };
        this.#bootstrapPresentationResourceUri =
            options.bootstrapPresentationResourceUri;
        this.#toolCallPresentationResourceUri = options.toolCallPresentationResourceUri;
        this.#toolCallPresentationResourceUriForTool = options.toolCallPresentationResourceUriForTool;
        this.#contextSelector =
            options.contextSelector ?? createMcpContextSelector("explicit");
        this.#instanceName = options.instanceName;
        this.#instanceRoutingEnabled = options.instanceRoutingEnabled === true && this.#contextSelector.id !== "stateless";
        this.#source = options.source;
        const appEnabled = options.appEnabled;
        this.#appEnabled = typeof appEnabled === "function" ? appEnabled : () => appEnabled !== false;
    }

    snapshot(): McpEndpointCatalogSnapshot {
        return {
            entries: this.#source.list(this.#instanceName).filter((entry) => this.#allowsEntry(entry)),
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
        const entry = this.#source.get(instanceName, toolName);
        return entry !== undefined && this.#allowsEntry(entry) ? entry.definition : undefined;
    }

    getEntry(toolName: string): McpToolSourceEntry | undefined {
        const entry = this.#source.get(this.#instanceName, toolName);
        return entry !== undefined && this.#allowsEntry(entry) ? entry : undefined;
    }

    #allowsEntry(entry: McpToolSourceEntry): boolean {
        const name = entry.definition.name;
        if (this.#contextSelector.id === "stateless")
            return entry.scope === this.#instanceName && statelessToolNames.has(name);
        return this.#appEnabled() || (!name.startsWith("mcpapp_") && isModelFacingTool(entry.definition));
    }

    adapt(tool: ToolDefinition): McpTool {
        const stateless = this.#contextSelector.id === "stateless";
        if (stateless && tool.name === "bash_run") tool = withStatelessCwd(tool);
        const appEnabled = this.#appEnabled();
        const modelTool = appEnabled ? withBootstrapPresentation(
            tool,
            this.#bootstrapPresentationResourceUri,
            this.#toolCallPresentationResourceUri,
            this.#toolCallPresentationResourceUriForTool,
        ) : { ...tool, _meta: withoutAppMetadata(asRecord(tool._meta)) };
        const provenanceTool =
            isBootstrapTool(modelTool.name) || !isModelFacingTool(modelTool)
                ? modelTool
                : withMcpProvenance(modelTool);
        const modelFacing = isModelFacingTool(provenanceTool);
        const explicit = this.#contextSelector.requiresExplicitContextId;
        const contextualTool = !modelFacing
            ? withMcpContextId(provenanceTool, "Internal Context ID carried by the MCP App.")
            : explicit && !isBootstrapTool(provenanceTool.name)
                ? withMcpContextId(provenanceTool)
                : provenanceTool;
        const exposed = isBootstrapTool(contextualTool.name)
            ? contextualTool
            : withMcpCommentOutputSchema(contextualTool);
        const adapted = this.#schemaAdapter.toMcpTool(
            exposed,
            (stateless ? statelessToolDescriptions[exposed.name] ?? exposed.description : exposed.description).trim(),
            {
                hiddenInputProperties: [
                    ...mcpToolHiddenInputProperties(exposed._meta),
                    ...(!explicit && modelFacing ? ["ctxId"] : []),
                ],
                inputHints: {
                    ...mcpToolInputHints(exposed._meta),
                    ...(stateless ? statelessInputHints[exposed.name] : undefined),
                },
                modelFacing,
                preserveInputDescriptions: mcpToolPreserveInputDescriptions(
                    exposed._meta,
                ),
                exposeContextOutput: explicit && exposed.name === "environ_info",
            },
        );
        const securitySchemes = mcpToolSecuritySchemes(this.#auth);
        const invocationStatus = mcpToolInvocationStatus(exposed._meta);
        const meta = {
            ...asRecord(adapted._meta),
            ...(!appEnabled || invocationStatus === undefined
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

const statelessToolNames = new Set([
    "bash_run", "task_input", "task_inspect", "task_manage",
    "file_read", "file_edit", "file_glob", "file_grep",
]);

const statelessToolDescriptions: Readonly<Record<string, string>> = {
    task_input: "Send raw UTF-8 input to a stateless PTY task or omit/empty input to read output using an opaque cursor.",
    task_inspect: "Inspect a stateless PTY screen without consuming its output.",
    file_read: "Read absolute Worker paths or retained bash_run output paths. Use nextSelector to continue a truncated read.",
    file_edit: "Apply one ordered change set using absolute Worker paths. No prior file_read is required; later operations do not execute after a failure.",
    file_glob: "Locate files and directories by absolute Worker paths or globs. Continue a paged traversal with cursor alone.",
    file_grep: "Search text across absolute Worker paths, directories or globs. Continue per-file truncation with startLine and traversal pages with cursor alone.",
};

const statelessInputHints: Readonly<Record<string, Record<string, string>>> = {
    bash_run: { cwd: statelessCwdHint },
    file_read: { path: "Absolute Worker file path or a retained bash_run output path." },
    file_glob: { patterns: "Absolute Worker paths or globs; required without cursor." },
    file_grep: { paths: "Absolute Worker paths or globs; required without cursor." },
    task_manage: { cwd: "Required absolute Worker directory for command=create." },
};

function isBootstrapTool(name: string): boolean {
    return toolNamespace(name) === bootstrapToolNamespace;
}

function withBootstrapPresentation(
    tool: ToolDefinition,
    workspaceResourceUri: string | undefined,
    toolCallResourceUri: string | undefined,
    toolCallResourceUriForTool: ((toolName: string) => string | undefined) | undefined,
): ToolDefinition {
    if (!isModelFacingTool(tool)) return tool;
    // Task input/output polling continues an existing task, not another presentation.
    if (tool.name === "task_input") return tool;
    const meta = asRecord(tool._meta);
    const ui = asRecord(meta.ui);
    // A tool's own MCP App binding always takes precedence.
    if (typeof ui.resourceUri === "string" || typeof meta["openai/outputTemplate"] === "string")
        return tool;
    const resourceUri = tool.name === "mcpapp_open" ? workspaceResourceUri
        : toolCallResourceUriForTool === undefined
            ? toolCallResourceUri ??
                (tool.name === `${bootstrapToolNamespace}_info` ? workspaceResourceUri : undefined)
            : toolCallResourceUriForTool(tool.name);
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
            ...(tool.name === "mcpapp_open"
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

export function withoutAppMetadata<T>(value: Record<string, T> | undefined): Record<string, T> | undefined {
    if (value === undefined) return undefined;
    const metadata = Object.fromEntries(Object.entries(value).filter(([key]) =>
        key !== "ui" && !key.startsWith("ui/") && !key.startsWith("openai/") &&
        key !== "portable-devshell/widgetPayload" && key !== "portable-devshell/mcpapp"));
    return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function isModelFacingTool(tool: ToolDefinition): boolean {
    const visibility = asRecord(asRecord(tool._meta).ui).visibility;
    return (
        !Array.isArray(visibility) ||
        visibility.some((entry) => entry === "model")
    );
}
