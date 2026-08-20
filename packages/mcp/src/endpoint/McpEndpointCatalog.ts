import type { JsonValue, ToolDefinition, ToolPolicy } from "@portable-devshell/shared";

import type { McpAuthConfig } from "../auth/McpAuthConfig.js";
import { createMcpContextSelector, type McpContextSelector } from "../context/McpContextSelector.js";
import { isMcpInteractionGateway, type McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import { mcpToolAnnotations } from "../tool/McpToolAnnotations.js";
import { McpToolDescriptionEnhancer } from "../tool/McpToolDescriptionEnhancer.js";
import { mcpToolInvocationStatus, mcpToolTitle } from "../tool/McpToolTitle.js";
import {
    McpToolSchemaAdapter,
    McpToolSchemaUnavailableError,
    type McpTool
} from "../tool/McpToolSchemaAdapter.js";
import { McpToolCatalogArtifact } from "../tool/catalog/McpToolCatalogArtifact.js";
import {
    McpToolCatalogEndpoint,
    type McpToolCatalogEndpointEntry,
    type McpToolCatalogEndpointSource
} from "../tool/catalog/McpToolCatalogEndpoint.js";
import {
    McpToolCatalogEnvironment,
    mcpEnvironmentToolName
} from "../tool/catalog/McpToolCatalogEnvironment.js";
import { McpToolCatalogInstance } from "../tool/catalog/McpToolCatalogInstance.js";
import { McpToolCatalogInteraction } from "../tool/catalog/McpToolCatalogInteraction.js";
import { McpToolCatalogTodo } from "../tool/catalog/McpToolCatalogTodo.js";
import { withMcpCommentOutputSchema } from "./McpEndpointFeedback.js";
import {
    withMcpContextId,
    withMcpInstanceTarget
} from "./McpEndpointInput.js";

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
    policy: ToolPolicy;
    worker: McpEndpointCatalogWorker;
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
    readonly #instanceTools = new McpToolCatalogInstance();
    readonly #interactionTools = new McpToolCatalogInteraction();
    readonly #schemaAdapter = new McpToolSchemaAdapter();
    readonly #todoTools = new McpToolCatalogTodo();
    readonly #worker: McpEndpointCatalogWorker;

    constructor(options: McpEndpointCatalogOptions) {
        this.#auth = options.auth ?? { enabled: false, provider: "none" };
        this.#catalog = new McpToolCatalogEndpoint(options.policy);
        this.#contextSelector = options.contextSelector ?? createMcpContextSelector("explicit");
        this.#gateway = options.gateway;
        this.#instanceName = options.instanceName;
        this.#worker = options.worker;
    }

    snapshot(): McpEndpointCatalogSnapshot {
        const hasWorkerSchema = this.#worker.snapshot().ready === true ||
            this.#worker.hasToolSchemaCache?.() === true;
        const merged = this.#catalog.merge(this.#sources(hasWorkerSchema));
        const exposed = this.#catalog.filter(merged);
        return {
            exposed,
            hasWorkerSchema,
            instanceRoutingEnabled: exposed.some((entry) => entry.owner === "instance"),
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

    isAllowed(tool: ToolDefinition): boolean {
        return this.#catalog.isAllowed(tool);
    }

    adapt(tool: ToolDefinition): McpTool {
        const exposed = tool.name === mcpEnvironmentToolName
            ? tool
            : withMcpCommentOutputSchema(
                  this.#contextSelector.requiresExplicitContextId ? withMcpContextId(tool) : tool
              );
        const adapted = this.#schemaAdapter.toMcpTool(
            exposed,
            this.#descriptionEnhancer.enhance(exposed.description)
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
        const sources: McpToolCatalogEndpointSource[] = [{
            owner: "environment",
            tools: this.#environmentTools.list(this.#contextSelector.requiresExplicitContextId)
        }];

        if (hasWorkerSchema) {
            sources.push({
                owner: "worker",
                tools: this.#worker.listTools()
            });
        }

        if (this.#gateway !== undefined) {
            const artifactTools = this.#artifactTools.list({
                share: this.#gateway.shareArtifact !== undefined,
                transfer: this.#gateway.transferArtifact !== undefined,
                viewImage: this.#gateway.viewArtifactImage !== undefined
            });
            if (artifactTools.length > 0) {
                sources.push({
                    owner: "artifact",
                    tools: artifactTools
                });
            }
            if (isMcpInteractionGateway(this.#gateway)) {
                sources.push({
                    owner: "workspace",
                    tools: this.#interactionTools.list(this.#contextSelector.requiresExplicitContextId)
                });
            }
            sources.push(
                {
                    owner: "todo",
                    tools: this.#todoTools.list(this.#contextSelector.requiresExplicitContextId)
                },
                {
                    owner: "instance",
                    tools: this.#instanceTools.list()
                }
            );
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
