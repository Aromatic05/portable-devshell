import type { McpHost, McpOAuthApprovalService } from "@portable-devshell/mcp";
import type { JsonValue } from "@portable-devshell/shared";

import { ConfigEditorCoordinator } from "../ConfigEditorCoordinator.js";
import { ControlMcpInstanceGateway } from "../ControlMcpInstanceGateway.js";
import { createArtifactMcpGateway } from "../ArtifactMcpGateway.js";
import { InstanceCreateCoordinator } from "../InstanceCreateCoordinator.js";
import { McpRuntimeFactory } from "../McpRuntimeFactory.js";
import type { ControlPathHome } from "@portable-devshell/shared";
import type { ArtifactRuntime } from "./ArtifactRuntime.js";
import type { ControlState } from "./ControlState.js";

export interface McpRuntimeOptions {
    artifact: ArtifactRuntime;
    controlPaths: ControlPathHome;
    factory?: McpRuntimeFactory;
    state: ControlState;
}

export class McpRuntime {
    readonly configEditor: ConfigEditorCoordinator;
    readonly instanceCreate: InstanceCreateCoordinator;
    readonly instanceGateway: ControlMcpInstanceGateway;
    readonly #host?: McpHost;

    constructor(options: McpRuntimeOptions) {
        const factory = options.factory ?? new McpRuntimeFactory();
        const gatewayHolder: { value?: ControlMcpInstanceGateway } = {};
        this.instanceCreate = new InstanceCreateCoordinator({
            configStore: options.state.configStore,
            getConfig: () => options.state.requireConfig(),
            getMcpHost: () => this.#host,
            getMcpInstanceGateway: () => gatewayHolder.value,
            homeDirectory: options.state.homeDirectory,
            instanceRegistry: options.state.instances,
            setConfig: (config) => options.state.setConfig(config)
        });
        this.instanceGateway = new ControlMcpInstanceGateway({
            createService: this.instanceCreate,
            getConfig: () => options.state.requireConfig(),
            instanceRegistry: options.state.instances
        });
        gatewayHolder.value = this.instanceGateway;
        this.#host = factory.wire(options.state.requireConfig(), options.state.instances, {
            contextFile: options.controlPaths.contextsFile,
            gateway: createArtifactMcpGateway(this.instanceGateway, options.artifact.service),
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
