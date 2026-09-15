import {
    bootstrapToolNamespace,
    createError,
    errorCodes,
    toolNamespace,
    type JsonValue,
    type ToolDefinition
} from "@portable-devshell/shared";

import type { McpAuthConfig } from "../../auth/Config.js";
import { createMcpContextSelector, type McpContextSelector } from "../../context/Selector.js";
import { isMcpInteractionGateway, type McpInstanceGateway } from "../Port.js";
import { mcpToolAnnotations } from "./Metadata.js";
import { McpToolDescriptionEnhancer } from "./Metadata.js";
import { mcpToolInvocationStatus, mcpToolTitle } from "./Metadata.js";
import {
    McpToolSchemaAdapter,
    McpToolSchemaUnavailableError,
    type McpTool
} from "./Schema.js";
import { McpToolCatalogArtifact } from "../domain/artifact/Catalog.js";
import {
    isMcpEnvironmentToolName,
    McpToolCatalogEnvironment
} from "../domain/environment/Catalog.js";
import { McpToolCatalogInteraction } from "../domain/interaction/Catalog.js";
import { McpToolCatalogTodo } from "../domain/todo/Catalog.js";
import { withMcpCommentOutputSchema } from "../domain/interaction/Handler.js";
import {
    withMcpContextId,
    withMcpInstanceTarget,
    withMcpProvenance
} from "../dispatch/Input.js";

export interface McpEndpointCatalogWorker {
    hasToolSchemaCache?(): boolean;
    listTools(): ToolDefinition[];
    snapshot(): { ready?: boolean };
}

export interface McpEndpointCatalogOptions {
    auth?: McpAuthConfig;
    contextSelector?: McpContextSelector;
    gateway?: McpInstanceGateway;
    instanceName: string;
    worker: McpEndpointCatalogWorker;
    workspaceAppEnabled?: boolean;
}

export interface McpEndpointCatalogSnapshot {
    exposed: McpToolCatalogEndpointEntry[];
    hasWorkerSchema: boolean;
    instanceRoutingEnabled: boolean;
    merged: McpToolCatalogEndpointEntry[];
}

export class McpEndpointCatalog {
    readonly #auth: McpAuthConfig;
    readonly #artifactTools = new McpToolCatalogArtifact();
    readonly #catalog: McpToolCatalogEndpoint;
    readonly #contextSelector: McpContextSelector;
    readonly #descriptionEnhancer = new McpToolDescriptionEnhancer();
    readonly #environmentTools = new McpToolCatalogEnvironment();
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #interactionTools = new McpToolCatalogInteraction();
    readonly #schemaAdapter = new McpToolSchemaAdapter();
    readonly #todoTools = new McpToolCatalogTodo();
    readonly #worker: McpEndpointCatalogWorker;
    readonly #workspaceAppEnabled: boolean;

    constructor(options: McpEndpointCatalogOptions) {
        this.#auth = options.auth ?? { enabled: false, provider: "none" };
        this.#catalog = new McpToolCatalogEndpoint();
        this.#contextSelector = options.contextSelector ?? createMcpContextSelector("explicit");
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#worker = options.worker;
        this.#workspaceAppEnabled = options.workspaceAppEnabled !== false;
    }

    snapshot(): McpEndpointCatalogSnapshot {
        const hasWorkerSchema = this.#worker.snapshot().ready === true ||
            this.#worker.hasToolSchemaCache?.() === true;
        const merged = this.#catalog.merge(this.#sources(hasWorkerSchema));
        const exposed = merged;
        return {
            exposed,
            hasWorkerSchema,
            instanceRoutingEnabled: this.#gateway !== undefined,
            merged
        };
    }

    listTools(): McpTool[] {
        const snapshot = this.snapshot();
        if (!snapshot.hasWorkerSchema && snapshot.exposed.length === 0) {
            throw new McpToolSchemaUnavailableError(this.#instanceName);
        }

        return snapshot.exposed.map((entry) => {
            return this.adapt(
                this.#withRoutingTarget(entry, snapshot.instanceRoutingEnabled)
            );
        });
    }

    getKnown(toolName: string): McpToolCatalogEndpointEntry | undefined {
        return this.snapshot().merged.find((entry) => {
            return entry.definition.name === toolName;
        });
    }

    getExposed(toolName: string): McpToolCatalogEndpointEntry | undefined {
        return this.snapshot().exposed.find((entry) => {
            return entry.definition.name === toolName;
        });
    }

    getTool(toolName: string): ToolDefinition | undefined {
        return this.getExposed(toolName)?.definition;
    }

    adapt(tool: ToolDefinition): McpTool {
        const modelTool = hideInternalWorkerInput(tool);
        const provenanceTool = isMcpEnvironmentToolName(modelTool.name) || !isModelFacingTool(modelTool)
            ? modelTool
            : withMcpProvenance(modelTool);
        const modelFacing = isModelFacingTool(provenanceTool);
        const contextualTool = this.#contextSelector.requiresExplicitContextId || !modelFacing
            ? withMcpContextId(
                  provenanceTool,
                  modelFacing
                      ? undefined
                      : "Internal Context ID carried by the Workspace App.",
              )
            : provenanceTool;
        const exposed = isMcpEnvironmentToolName(contextualTool.name)
            ? contextualTool
            : withMcpCommentOutputSchema(contextualTool);
        const adapted = this.#schemaAdapter.toMcpTool(
            exposed,
            this.#descriptionEnhancer.enhance(exposed.name, exposed.description),
            { modelFacing },
        );
        const securitySchemes = mcpToolSecuritySchemes(this.#auth);
        const invocationStatus = mcpToolInvocationStatus(exposed.name);
        const meta = {
            ...asRecord(adapted._meta),
            ...(invocationStatus === undefined ? {} : {
                "openai/toolInvocation/invoked": invocationStatus.invoked,
                "openai/toolInvocation/invoking": invocationStatus.invoking,
            }),
            ...(securitySchemes === undefined ? {} : { securitySchemes }),
        };
        return {
            ...adapted,
            ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }),
            ...(securitySchemes === undefined ? {} : { securitySchemes }),
            annotations: mcpToolAnnotations(exposed.name),
            title: mcpToolTitle(exposed.name),
        };
    }

    assertAdaptable(tool: ToolDefinition): void {
        this.adapt(tool);
    }

    #sources(hasWorkerSchema: boolean): McpToolCatalogEndpointSource[] {
        const workspaceTools = this.#workspaceAppEnabled && this.#gateway !== undefined && isMcpInteractionGateway(this.#gateway)
            ? this.#interactionTools.list()
            : [];
        const workspaceApp = workspaceTools.some((tool) => tool.name === "workspace_open");
        const sources: McpToolCatalogEndpointSource[] = [{
            owner: "environment",
            tools: this.#environmentTools.list({
                remoteEnvironment: this.#gateway !== undefined,
                requireExplicitContextId: this.#contextSelector.requiresExplicitContextId,
                workspaceApp,
            })
        }];

        if (hasWorkerSchema) {
            sources.push({
                owner: "worker",
                tools: this.#worker.listTools()
            });
        }

        if (this.#gateway !== undefined) {
            const artifactTools = this.#artifactTools.list({
                viewImage: this.#gateway.viewArtifactImage !== undefined
            });
            if (artifactTools.length > 0) {
                sources.push({
                    owner: "artifact",
                    tools: artifactTools
                });
            }
            if (workspaceTools.length > 0) {
                sources.push({
                    owner: "workspace",
                    tools: workspaceTools
                });
            }
            sources.push({
                owner: "todo",
                tools: this.#todoTools.list()
            });
        }

        return sources;
    }

    #withRoutingTarget(
        entry: McpToolCatalogEndpointEntry,
        instanceRoutingEnabled: boolean
    ): ToolDefinition {
        if (
            instanceRoutingEnabled &&
            (entry.owner === "worker" || entry.owner === "artifact")
        ) {
            return withMcpInstanceTarget(entry.definition);
        }
        return entry.definition;
    }
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
    return !Array.isArray(visibility) || visibility.some((entry) => entry === "model");
}

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
