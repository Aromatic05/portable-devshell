import {
    McpRuntimeState,
    type McpHost,
    type McpOAuthApprovalService,
} from "@portable-devshell/mcp";
import type {
    ContextTransport,
    ControlConfig,
    JsonValue,
} from "@portable-devshell/shared";

import type { InstanceMcpRuntimePort } from "../../instance/Mcp.js";
import {
    createToolCallProvenanceRuntime,
    type ToolCallProvenanceApi,
} from "@portable-devshell/shared";
import type { InstanceRegistry } from "../../instance/Api.js";
import { McpEndpointFactory } from "./Endpoint.js";
import { McpRuntimeFactory } from "./Runtime.js";
import type { ControlPathHome } from "@portable-devshell/shared";
import type { ArtifactRuntime } from "../../artifact/Api.js";
import type { ToolCallRegistry } from "../../toolcall/Api.js";

export interface McpControlModuleOptions {
    artifact: ArtifactRuntime;
    config: ControlConfig;
    contextTransport: ContextTransport;
    controlPaths: ControlPathHome;
    factory?: McpRuntimeFactory;
    instances: InstanceRegistry;
    toolRegistry: ToolCallRegistry;
}

export class McpControlModule {
    readonly instancePort: InstanceMcpRuntimePort;
    readonly toolProvenance: ToolCallProvenanceApi;
    #publicBaseUrl?: string;
    #oauthApproval: ControlConfig["mcp"]["oauth2"];
    #host?: McpHost;
    readonly #factory: McpRuntimeFactory;
    readonly #instances: InstanceRegistry;
    readonly #artifact: ArtifactRuntime;
    readonly #controlPaths: ControlPathHome;
    readonly #runtimeState: McpRuntimeState;
    readonly #toolRegistry: ToolCallRegistry;

    constructor(options: McpControlModuleOptions) {
        const factory = options.factory ?? new McpRuntimeFactory();
        this.#factory = factory;
        this.#instances = options.instances;
        this.#artifact = options.artifact;
        this.#controlPaths = options.controlPaths;
        this.#toolRegistry = options.toolRegistry;
        this.#runtimeState = new McpRuntimeState({
            context: options.contextTransport,
            tools: { call: (instance, ...args) => {
                const target = options.instances.get(instance);
                if (target === undefined)
                    throw new Error(`Instance ${instance} is unavailable.`);
                return target.toolCallIngress.call(instance, ...args);
            } },
            storageDir: options.controlPaths.oauthDir,
            mcpAppLeaseFile: options.controlPaths.mcpAppLeasesFile,
        });
        this.toolProvenance = createToolCallProvenanceRuntime(
            options.controlPaths.toolProvenanceFile,
        );
        const config = options.config;
        this.#oauthApproval = config.mcp.oauth2;
        this.#publicBaseUrl = config.mcp.publicBaseUrl;
        const endpointFactory = new McpEndpointFactory();
        this.instancePort = {
            registerInstance: (instance, auth) => {
                const descriptor = options.instances.get(instance);
                if (descriptor === undefined) return;
                this.#host?.registerInstance(
                    endpointFactory.map(descriptor, auth),
                );
            },
            unregisterInstance: (instance) => {
                this.#host?.unregisterInstance(instance);
            },
            retireMcpApp: async (instance) => {
                await this.#host?.retireMcpApp(instance);
            },
        };
        this.#host = factory.wire(config, options.instances, {
            storageDir: options.controlPaths.oauthDir,
            runtimeState: this.#runtimeState,
            toolProvenance: this.toolProvenance,
            toolSource: this.#toolRegistry,
            mcpAppLeaseFile: options.controlPaths.mcpAppLeasesFile,
        });
        if (this.#host !== undefined)
            options.artifact.installHttpRoute(this.#host.server);
    }

    get host(): McpHost | undefined {
        return this.#host;
    }

    get oauthApproval(): ControlConfig["mcp"]["oauth2"] {
        return this.#oauthApproval;
    }

    get publicBaseUrl(): string | undefined {
        return this.#publicBaseUrl;
    }

    async replaceMcpHost(
        previousConfig: ControlConfig,
        config: ControlConfig,
    ): Promise<McpHost | undefined> {
        const next = this.#factory.wire(config, this.#instances, {
            storageDir: this.#controlPaths.oauthDir,
            runtimeState: this.#runtimeState,
            toolProvenance: this.toolProvenance,
            toolSource: this.#toolRegistry,
            mcpAppLeaseFile: this.#controlPaths.mcpAppLeasesFile,
        });
        const previous = this.#host;
        const sameEndpointAsPrevious =
            previous !== undefined &&
            sameEndpoint(previousConfig.mcp, config.mcp);
        if (sameEndpointAsPrevious) await previous.stop();
        try {
            if (next !== undefined) {
                this.#artifact.installHttpRoute(next.server);
                await next.start();
            }
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            if (sameEndpointAsPrevious) {
                await previous
                    ?.start()
                    .catch((rollbackError) =>
                        rollbackFailures.push(rollbackError),
                    );
            }
            if (rollbackFailures.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackFailures],
                    "MCP host replacement failed and rollback was incomplete.",
                );
            }
            throw error;
        }
        this.#host = next;
        this.#oauthApproval = config.mcp.oauth2;
        this.#publicBaseUrl = config.mcp.enabled
            ? config.mcp.publicBaseUrl
            : undefined;
        return previous;
    }

    async restoreMcpHost(
        host: McpHost | undefined,
        config: ControlConfig,
    ): Promise<void> {
        const current = this.#host;
        this.#host = host;
        this.#oauthApproval = config.mcp.oauth2;
        this.#publicBaseUrl = config.mcp.enabled
            ? config.mcp.publicBaseUrl
            : undefined;
        const failures: unknown[] = [];
        if (current !== undefined && current !== host) {
            await current.stop().catch((error) => failures.push(error));
        }
        if (host !== undefined) {
            this.#artifact.installHttpRoute(host.server);
            await host.start().catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "MCP host rollback was incomplete.",
            );
        }
    }

    get oauthApprovals(): McpOAuthApprovalService | undefined {
        return this.#host?.oauthApprovals;
    }

    status(): JsonValue {
        if (this.#host === undefined) {
            return {
                running: false,
                reason: "MCP runtime is disabled.",
            };
        }
        return (
            (
                this.#host as unknown as { status(): JsonValue } | undefined
            )?.status() ?? {
                running: false,
                reason: "MCP runtime is disabled.",
            }
        );
    }

    async start(): Promise<void> {
        await this.#host?.start();
    }

    async stop(): Promise<void> {
        const failures: unknown[] = [];
        await this.#host?.stop().catch((error) => failures.push(error));
        await this.toolProvenance
            .flush()
            .catch((error) => failures.push(error));
        if (failures.length > 0) {
            throw new AggregateError(failures, "MCP module shutdown failed.");
        }
    }
}

function sameEndpoint(
    left: { listenHost: string; listenPort: number },
    right: { listenHost: string; listenPort: number },
): boolean {
    return (
        left.listenHost === right.listenHost &&
        left.listenPort === right.listenPort
    );
}
