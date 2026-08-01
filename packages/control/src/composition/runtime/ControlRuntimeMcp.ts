import { HttpHost, type McpHost, type McpOAuthApprovalService } from "@portable-devshell/mcp";
import type { ControlConfig, JsonValue } from "@portable-devshell/shared";

import { ConfigEditorCoordinator } from "../../control/config/editor/ConfigEditorCoordinator.js";
import { McpInstanceGatewayControl } from "../McpInstanceGatewayControl.js";
import { decorateMcpInstanceGatewayArtifact } from "../McpInstanceGatewayArtifactDecorator.js";
import { InstanceCreateCoordinator } from "../../control/instance/create/InstanceCreateCoordinator.js";
import { McpRuntimeFactory } from "../McpRuntimeFactory.js";
import type { ControlPathHome } from "@portable-devshell/shared";
import type { ControlRuntimeArtifact } from "./ControlRuntimeArtifact.js";
import type { ControlRuntimeState } from "./ControlRuntimeState.js";

export interface ControlRuntimeMcpOptions {
    artifact: ControlRuntimeArtifact;
    applyRuntimeConfig?: (previous: ControlConfig, next: ControlConfig) => Promise<void>;
    controlPaths: ControlPathHome;
    factory?: McpRuntimeFactory;
    state: ControlRuntimeState;
}

export class ControlRuntimeMcp {
    readonly configEditor: ConfigEditorCoordinator;
    readonly instanceCreate: InstanceCreateCoordinator;
    readonly instanceGateway: McpInstanceGatewayControl;
    readonly publicBaseUrl?: string;
    #webHost?: HttpHost;
    #webPublicBaseUrl?: string;
    #webEnabled: boolean;
    #host?: McpHost;
    readonly #mcpEnabled: boolean;
    readonly #factory: McpRuntimeFactory;
    readonly #state: ControlRuntimeState;
    readonly #artifact: ControlRuntimeArtifact;
    readonly #controlPaths: ControlPathHome;
    readonly #applyRuntimeConfig?: (previous: ControlConfig, next: ControlConfig) => Promise<void>;
    #applyWebConfig?: (previous: ControlConfig, next: ControlConfig) => Promise<void>;
    #applyMcpConfig?: (previous: ControlConfig, next: ControlConfig) => Promise<void>;

    constructor(options: ControlRuntimeMcpOptions) {
        const factory = options.factory ?? new McpRuntimeFactory();
        this.#factory = factory;
        this.#state = options.state;
        this.#artifact = options.artifact;
        this.#controlPaths = options.controlPaths;
        const config = options.state.requireConfig();
        this.#applyRuntimeConfig = options.applyRuntimeConfig;
        this.#mcpEnabled = config.mcp.enabled;
        this.publicBaseUrl = config.mcp.publicBaseUrl;
        this.#webEnabled = config.web.enabled;
        const gatewayHolder: { value?: McpInstanceGatewayControl } = {};
        this.instanceCreate = new InstanceCreateCoordinator({
            configStore: options.state.configStore,
            getConfig: () => options.state.requireConfig(),
            getMcpHost: () => this.#host,
            getMcpInstanceGateway: () => gatewayHolder.value,
            homeDirectory: options.state.homeDirectory,
            instanceRegistry: options.state.instances,
            setConfig: (config) => options.state.setConfig(config)
        });
        this.instanceGateway = new McpInstanceGatewayControl({
            createService: this.instanceCreate,
            getConfig: () => options.state.requireConfig(),
            instanceRegistry: options.state.instances
        });
        gatewayHolder.value = this.instanceGateway;
        this.#host = factory.wire(options.state.requireConfig(), options.state.instances, {
            contextFile: options.controlPaths.contextsFile,
            gateway: decorateMcpInstanceGatewayArtifact(this.instanceGateway, options.artifact.service),
            storageDir: options.controlPaths.oauthDir
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
            homeDirectory: options.state.homeDirectory,
            instanceRegistry: options.state.instances,
            runtimeApply: options.applyRuntimeConfig === undefined ? undefined : {
                apply: async (previous, next) => await this.#applyConfig(previous, next)
            },
            setConfig: (config) => options.state.setConfig(config)
        });
    }

    get host(): McpHost | undefined {
        return this.#host;
    }

    setWebConfigApplier(apply: (previous: ControlConfig, next: ControlConfig) => Promise<void>): void {
        this.#applyWebConfig = apply;
    }

    setMcpConfigApplier(apply: (previous: ControlConfig, next: ControlConfig) => Promise<void>): void {
        this.#applyMcpConfig = apply;
    }

    async replaceMcpHost(config: ControlConfig): Promise<McpHost | undefined> {
        const next = this.#factory.wire(config, this.#state.instances, {
            contextFile: this.#controlPaths.contextsFile,
            gateway: decorateMcpInstanceGatewayArtifact(this.instanceGateway, this.#artifact.service),
            storageDir: this.#controlPaths.oauthDir
        });
        this.#artifact.installHttpRoute(next!.server);
        await next?.start();
        const previous = this.#host;
        this.#host = next;
        return previous;
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

    async replaceWebHost(config: ControlConfig): Promise<HttpHost | undefined> {
        const previous = this.#webHost;
        const next = config.web.enabled
            ? this.#host !== undefined && sameEndpoint(config.mcp, config.web)
                ? this.#host.server
                : new HttpHost({ listenHost: config.web.listenHost, listenPort: config.web.listenPort })
            : undefined;
        if (next !== undefined && next !== previous && next !== this.#host?.server) {
            await next.start();
        }
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
        this.#webEnabled = config.web.enabled;
        this.#webPublicBaseUrl = config.web.enabled ? config.web.publicBaseUrl : undefined;
        this.#webHost = host;
        if (current !== undefined && current !== host && current !== this.#host?.server) {
            await current.stop();
        }
    }

    async #applyConfig(previous: ControlConfig, next: ControlConfig): Promise<void> {
        if (
            previous.web.enabled &&
            next.web.enabled &&
            JSON.stringify(previous.mcp) === JSON.stringify(next.mcp) &&
            this.#applyWebConfig !== undefined
        ) {
            await this.#applyWebConfig(previous, next);
            return;
        }
        if (
            previous.mcp.enabled &&
            next.mcp.enabled &&
            JSON.stringify(previous.web) === JSON.stringify(next.web) &&
            previous.web.enabled &&
            !sameEndpoint(previous.mcp, previous.web) &&
            this.#applyMcpConfig !== undefined
        ) {
            await this.#applyMcpConfig(previous, next);
            return;
        }
        await this.#applyRuntimeConfig?.(previous, next);
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

function sameEndpoint(
    left: { listenHost: string; listenPort: number },
    right: { listenHost: string; listenPort: number }
): boolean {
    return left.listenHost === right.listenHost && left.listenPort === right.listenPort;
}
