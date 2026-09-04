import { join } from "node:path";

import { HttpHost, type McpHost, type McpOAuthApprovalService } from "@portable-devshell/mcp";
import type { ControlConfig, ControlWebAuthConfig, JsonValue } from "@portable-devshell/shared";

import { ConfigEditorCoordinator, type ConfigRuntimeChangeSet } from "../../control/config/editor/ConfigEditorCoordinator.js";
import { ToolCallProvenanceStore } from "../../control/tool/ToolCallProvenanceStore.js";
import { McpInstanceGatewayControl } from "../McpInstanceGatewayControl.js";
import { decorateMcpInstanceGatewayArtifact } from "../McpInstanceGatewayArtifactDecorator.js";
import { InstanceCreateCoordinator } from "../../control/instance/create/InstanceCreateCoordinator.js";
import { McpRuntimeFactory } from "../McpRuntimeFactory.js";
import type { ControlPathHome } from "@portable-devshell/shared";
import type { ControlRuntimeArtifact } from "./ControlRuntimeArtifact.js";
import type { ControlRuntimeState } from "./ControlRuntimeState.js";

export interface ControlRuntimeMcpOptions {
    artifact: ControlRuntimeArtifact;
    controlPaths: ControlPathHome;
    factory?: McpRuntimeFactory;
    state: ControlRuntimeState;
}

export class ControlRuntimeMcp {
    readonly configEditor: ConfigEditorCoordinator;
    readonly instanceCreate: InstanceCreateCoordinator;
    readonly instanceGateway: McpInstanceGatewayControl;
    readonly toolProvenance: ToolCallProvenanceStore;
    #publicBaseUrl?: string;
    #webHost?: HttpHost;
    #webPublicBaseUrl?: string;
    #webAuth: ControlWebAuthConfig;
    #webEnabled: boolean;
    #host?: McpHost;
    readonly #mcpEnabled: boolean;
    readonly #factory: McpRuntimeFactory;
    readonly #state: ControlRuntimeState;
    readonly #artifact: ControlRuntimeArtifact;
    readonly #controlPaths: ControlPathHome;
    #applyWebConfig?: (previous: ControlConfig, next: ControlConfig) => Promise<void>;
    #applyMcpConfig?: (previous: ControlConfig, next: ControlConfig) => Promise<void>;

    constructor(options: ControlRuntimeMcpOptions) {
        const factory = options.factory ?? new McpRuntimeFactory();
        this.#factory = factory;
        this.#state = options.state;
        this.#artifact = options.artifact;
        this.#controlPaths = options.controlPaths;
        this.toolProvenance = new ToolCallProvenanceStore(options.controlPaths.toolProvenanceFile);
        const config = options.state.requireConfig();
        this.#mcpEnabled = config.mcp.enabled;
        this.#publicBaseUrl = config.mcp.publicBaseUrl;
        this.#webAuth = config.web.auth;
        this.#webEnabled = config.web.enabled;
        const gatewayHolder: { value?: McpInstanceGatewayControl } = {};
        this.instanceCreate = new InstanceCreateCoordinator({
            configStore: options.state.configStore,
            getConfig: () => options.state.requireConfig(),
            getMcpHost: () => this.#host,
            getMcpInstanceGateway: () => gatewayHolder.value,
            homeDirectory: options.state.homeDirectory,
            instanceRegistry: options.state.instances,
            mutationRunner: options.state.configMutations,
            setConfig: (config) => options.state.setConfig(config)
        });
        this.instanceGateway = new McpInstanceGatewayControl({
            createService: this.instanceCreate,
            getConfig: () => options.state.requireConfig(),
            instanceRegistry: options.state.instances,
            toolProvenance: this.toolProvenance
        });
        gatewayHolder.value = this.instanceGateway;
        this.#host = factory.wire(options.state.requireConfig(), options.state.instances, {
            contextFile: options.controlPaths.contextsFile,
            gateway: decorateMcpInstanceGatewayArtifact(this.instanceGateway, options.artifact.service),
            storageDir: options.controlPaths.oauthDir,
            toolProvenance: this.toolProvenance,
            workspaceAppLeaseFile: options.controlPaths.workspaceAppLeasesFile
        });
        if (config.web.enabled) {
            this.#webPublicBaseUrl = config.web.publicBaseUrl;
            this.#webHost = this.#host !== undefined && sameEndpoint(config.mcp, config.web)
                ? this.#host.server
                : new HttpHost({ listenHost: config.web.listenHost, listenPort: config.web.listenPort });
        }
        if (this.#host !== undefined) options.artifact.installHttpRoute(this.#host.server);
        this.configEditor = new ConfigEditorCoordinator({
            configStore: options.state.configStore,
            getConfig: () => options.state.requireConfig(),
            getMcpHost: () => this.#host,
            getMcpInstanceGateway: () => this.instanceGateway,
            getRestartControlRequired: () => options.state.restartControlRequired,
            homeDirectory: options.state.homeDirectory,
            instanceRegistry: options.state.instances,
            markRestartControlRequired: () => options.state.markRestartControlRequired(),
            mutationRunner: options.state.configMutations,
            runtimeApply: {
                apply: async (previous, next, changes) => await this.#applyConfig(previous, next, changes)
            },
            setConfig: (config) => options.state.setConfig(config)
        });
    }

    get host(): McpHost | undefined {
        return this.#host;
    }

    get publicBaseUrl(): string | undefined {
        return this.#publicBaseUrl;
    }

    setWebConfigApplier(apply: (previous: ControlConfig, next: ControlConfig) => Promise<void>): void {
        this.#applyWebConfig = apply;
    }

    setMcpConfigApplier(apply: (previous: ControlConfig, next: ControlConfig) => Promise<void>): void {
        this.#applyMcpConfig = apply;
    }

    async replaceMcpHost(previousConfig: ControlConfig, config: ControlConfig): Promise<McpHost | undefined> {
        const next = this.#factory.wire(config, this.#state.instances, {
            contextFile: this.#controlPaths.contextsFile,
            gateway: decorateMcpInstanceGatewayArtifact(this.instanceGateway, this.#artifact.service),
            storageDir: this.#controlPaths.oauthDir,
            toolProvenance: this.toolProvenance,
            workspaceAppLeaseFile: this.#controlPaths.workspaceAppLeasesFile
        });
        const previous = this.#host;
        const sameEndpointAsPrevious = previous !== undefined && sameEndpoint(previousConfig.mcp, config.mcp);
        if (sameEndpointAsPrevious) await previous.stop();
        try {
            if (next !== undefined) {
                this.#artifact.installHttpRoute(next.server);
                await next.start();
            }
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            if (sameEndpointAsPrevious) {
                await previous?.start().catch((rollbackError) => rollbackFailures.push(rollbackError));
            }
            if (rollbackFailures.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackFailures],
                    "MCP host replacement failed and rollback was incomplete."
                );
            }
            throw error;
        }
        this.#host = next;
        this.#publicBaseUrl = config.mcp.enabled ? config.mcp.publicBaseUrl : undefined;
        return previous;
    }

    async restoreMcpHost(host: McpHost | undefined, config: ControlConfig): Promise<void> {
        const current = this.#host;
        this.#host = host;
        this.#publicBaseUrl = config.mcp.enabled ? config.mcp.publicBaseUrl : undefined;
        const failures: unknown[] = [];
        if (current !== undefined && current !== host) {
            await current.stop().catch((error) => failures.push(error));
        }
        if (host !== undefined) {
            this.#artifact.installHttpRoute(host.server);
            await host.start().catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "MCP host rollback was incomplete.");
        }
    }

    get webAuth(): ControlWebAuthConfig {
        return this.#webAuth;
    }

    get webEnabled(): boolean {
        return this.#webEnabled;
    }

    get webHost(): HttpHost | undefined {
        return this.#webHost;
    }

    get webPublicBaseUrl(): string | undefined {
        return this.#webPublicBaseUrl;
    }

    get webOauthDir(): string {
        return join(this.#controlPaths.oauthDir, "web");
    }

    async replaceWebHost(previousConfig: ControlConfig, config: ControlConfig): Promise<HttpHost | undefined> {
        const previous = this.#webHost;
        const next = config.web.enabled
            ? this.#host !== undefined && sameEndpoint(config.mcp, config.web)
                ? this.#host.server
                : new HttpHost({ listenHost: config.web.listenHost, listenPort: config.web.listenPort })
            : undefined;
        const same = previous !== undefined && next !== undefined && next !== previous
            && next !== this.#host?.server && previous !== this.#host?.server
            && sameEndpoint(previousConfig.web, config.web);
        if (same && previous !== undefined) {
            await previous.stop();
        }
        if (next !== undefined && next !== previous && next !== this.#host?.server) {
            try {
                await next.start();
            } catch (error) {
                const rollbackFailures: unknown[] = [];
                if (same && previous !== undefined) {
                    await previous.start().catch((rollbackError) => rollbackFailures.push(rollbackError));
                }
                if (rollbackFailures.length > 0) {
                    throw new AggregateError(
                        [error, ...rollbackFailures],
                        "Web host replacement failed and rollback was incomplete."
                    );
                }
                throw error;
            }
        }
        this.#webAuth = config.web.auth;
        this.#webEnabled = config.web.enabled;
        this.#webPublicBaseUrl = config.web.enabled ? config.web.publicBaseUrl : undefined;
        this.#webHost = next;
        return previous;
    }

    async stopRetiredWebHost(host: HttpHost | undefined): Promise<void> {
        if (host !== undefined && host !== this.#webHost && host !== this.#host?.server) {
            await host.stop();
        }
    }

    async restoreWebHost(host: HttpHost | undefined, config: ControlConfig): Promise<void> {
        const current = this.#webHost;
        this.#webAuth = config.web.auth;
        this.#webEnabled = config.web.enabled;
        this.#webPublicBaseUrl = config.web.enabled ? config.web.publicBaseUrl : undefined;
        this.#webHost = host;
        if (current !== undefined && current !== host && current !== this.#host?.server) {
            await current.stop();
        }
        if (host !== undefined && host !== this.#host?.server) {
            await host.start();
        }
    }

    async #applyConfig(
        previous: ControlConfig,
        next: ControlConfig,
        changes: ConfigRuntimeChangeSet
    ): Promise<boolean> {
        if (changes.instanceAuth && !changes.mcp && !changes.web) return true;

        if (
            changes.web &&
            !changes.mcp &&
            previous.web.enabled &&
            next.web.enabled &&
            endpointIsIndependent(previous.web, previous.mcp, previous.mcp.enabled) &&
            endpointIsIndependent(next.web, next.mcp, next.mcp.enabled) &&
            this.#applyWebConfig !== undefined
        ) {
            await this.#applyWebConfig(previous, next);
            return true;
        }
        if (
            changes.mcp &&
            !changes.web &&
            previous.mcp.enabled &&
            next.mcp.enabled &&
            endpointIsIndependent(previous.mcp, previous.web, previous.web.enabled) &&
            endpointIsIndependent(next.mcp, next.web, next.web.enabled) &&
            this.#applyMcpConfig !== undefined
        ) {
            await this.#applyMcpConfig(previous, next);
            return true;
        }
        return false;
    }

    get oauthApprovals(): McpOAuthApprovalService | undefined {
        return this.#mcpEnabled ? this.#host?.oauthApprovals : undefined;
    }

    status(): JsonValue {
        if (!this.#mcpEnabled) {
            return {
                running: false,
                reason: "MCP runtime is disabled."
            };
        }
        return (this.#host as unknown as { status(): JsonValue } | undefined)?.status() ?? {
            running: false,
            reason: "MCP runtime is disabled."
        };
    }

    async start(): Promise<void> {
        await this.toolProvenance.warmup();
        await this.#host?.start();
        if (this.#webHost !== undefined && this.#webHost !== this.#host?.server) {
            await this.#webHost.start();
        }
    }

    async stop(): Promise<void> {
        if (this.#webHost !== undefined && this.#webHost !== this.#host?.server) {
            await this.#webHost.stop();
        }
        await this.#host?.stop();
    }
}

function endpointIsIndependent(
    endpoint: { listenHost: string; listenPort: number },
    other: { listenHost: string; listenPort: number },
    otherEnabled: boolean
): boolean {
    return !otherEnabled || !sameEndpoint(endpoint, other);
}

function sameEndpoint(
    left: { listenHost: string; listenPort: number },
    right: { listenHost: string; listenPort: number }
): boolean {
    return left.listenHost === right.listenHost && left.listenPort === right.listenPort;
}
