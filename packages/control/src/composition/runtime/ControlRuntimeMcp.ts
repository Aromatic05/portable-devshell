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
    readonly webHost?: HttpHost;
    readonly webPublicBaseUrl?: string;
    readonly webEnabled: boolean;
    readonly #host?: McpHost;
    readonly #mcpEnabled: boolean;

    constructor(options: ControlRuntimeMcpOptions) {
        const factory = options.factory ?? new McpRuntimeFactory();
        const config = options.state.requireConfig();
        this.#mcpEnabled = config.mcp.enabled;
        this.publicBaseUrl = config.mcp.publicBaseUrl;
        this.webEnabled = config.web.enabled;
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
            this.webPublicBaseUrl = config.web.publicBaseUrl;
            this.webHost = this.#host !== undefined && sameEndpoint(config.mcp, config.web)
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
            runtimeApply: options.applyRuntimeConfig === undefined ? undefined : { apply: options.applyRuntimeConfig },
            setConfig: (config) => options.state.setConfig(config)
        });
    }

    get host(): McpHost | undefined {
        return this.#host;
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
        if (this.webHost !== undefined && this.webHost !== this.#host?.server) {
            await this.webHost.start();
        }
    }

    async stop(): Promise<void> {
        if (this.webHost !== undefined && this.webHost !== this.#host?.server) {
            await this.webHost.stop();
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
