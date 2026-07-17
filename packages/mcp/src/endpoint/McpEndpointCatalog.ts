import type {
    ToolDefinition,
    ToolPolicy
} from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import { McpToolDescriptionEnhancer } from "../tool/McpToolDescriptionEnhancer.js";
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
import { McpToolCatalogTodo } from "../tool/catalog/McpToolCatalogTodo.js";
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
    readonly #artifactTools = new McpToolCatalogArtifact();
    readonly #catalog: McpToolCatalogEndpoint;
    readonly #descriptionEnhancer = new McpToolDescriptionEnhancer();
    readonly #environmentTools = new McpToolCatalogEnvironment();
    readonly #gateway?: McpInstanceGateway;
    readonly #instanceName: string;
    readonly #instanceTools = new McpToolCatalogInstance();
    readonly #schemaAdapter = new McpToolSchemaAdapter();
    readonly #todoTools = new McpToolCatalogTodo();
    readonly #worker: McpEndpointCatalogWorker;

    constructor(options: McpEndpointCatalogOptions) {
        this.#catalog = new McpToolCatalogEndpoint(options.policy);
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
            : withMcpContextId(tool);
        return this.#schemaAdapter.toMcpTool(
            exposed,
            this.#descriptionEnhancer.enhance(exposed.description)
        );
    }

    assertAdaptable(tool: ToolDefinition): void {
        this.adapt(tool);
    }

    #sources(hasWorkerSchema: boolean): McpToolCatalogEndpointSource[] {
        const sources: McpToolCatalogEndpointSource[] = [{
            owner: "environment",
            tools: this.#environmentTools.list()
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
            sources.push(
                {
                    owner: "todo",
                    tools: this.#todoTools.list()
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
