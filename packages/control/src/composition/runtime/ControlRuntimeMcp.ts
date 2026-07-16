import type { McpHost, McpOAuthApprovalService } from "@portable-devshell/mcp";
import type { JsonValue } from "@portable-devshell/shared";

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
    controlPaths: ControlPathHome;
    factory?: McpRuntimeFactory;
    state: ControlRuntimeState;
}

export class ControlRuntimeMcp {
    readonly configEditor: ConfigEditorCoordinator;
    readonly instanceCreate: InstanceCreateCoordinator;
    readonly instanceGateway: McpInstanceGatewayControl;
    readonly #host?: McpHost;

    constructor(options: ControlRuntimeMcpOptions) {
        const factory = options.factory ?? new McpRuntimeFactory();
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
        if (this.#host !== undefined) options.artifact.installHttpRoute(this.#host.server);
        this.configEditor = new ConfigEditorCoordinator({
            configStore: options.state.configStore,
            getConfig: () => options.state.requireConfig(),
            getMcpHost: () => this.#host,
            getMcpInstanceGateway: () => this.instanceGateway,
            homeDirectory: options.state.homeDirectory,
            instanceRegistry: options.state.instances,
            setConfig: (config) => options.state.setConfig(config)
        });
    }

    get host(): McpHost | undefined {
        return this.#host;
    }

    get oauthApprovals(): McpOAuthApprovalService | undefined {
        return this.#host?.oauthApprovals;
    }

    status(): JsonValue {
        return (this.#host as unknown as { status(): JsonValue } | undefined)?.status() ?? {
            running: false,
            reason: "MCP runtime is disabled."
        };
    }

    async start(): Promise<void> {
        await this.#host?.start();
    }

    async stop(): Promise<void> {
        await this.#host?.stop();
    }
}
