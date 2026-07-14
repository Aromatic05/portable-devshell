import { homedir } from "node:os";
import { join } from "node:path";
import { createError, errorCodes } from "@portable-devshell/shared";
import type { McpHost } from "@portable-devshell/mcp";

import { ArtifactHttpRoute, artifactShareRoute } from "../artifact/ArtifactHttpRoute.js";
import { ArtifactHostBridge } from "../artifact/host/ArtifactHostBridge.js";
import { ArtifactService } from "../artifact/ArtifactService.js";
import { ControlInstanceCreateService } from "./ControlInstanceCreateService.js";
import { ControlConfigEditorService } from "./editor/ConfigEditorService.js";
import { ControlConfigStore } from "./config/ControlConfigStore.js";
import type { ControlConfig } from "./config/codec/ConfigTomlCodec.js";
import { ControlPathHome } from "./path/ControlPathHome.js";
import { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";
import { InstanceRegistryBuilder } from "../instance/registry/InstanceRegistryBuilder.js";
import { withArtifactGateway } from "../mcp/McpArtifactGateway.js";
import { McpInstanceGatewayControl } from "../mcp/McpInstanceGatewayControl.js";
import { McpWiringService } from "../mcp/McpWiringService.js";
import { ControlRpcServer } from "./rpc/ControlRpcServer.js";
import { ControlSocketFile } from "./ControlSocketFile.js";
import { ReverseConnectionGateway } from "../reverse/ReverseConnectionGateway.js";
import { ReverseControlService } from "../reverse/ReverseControlService.js";
import { ReverseCredentialStore } from "../reverse/ReverseCredentialStore.js";

export interface ControlServerOptions {
    configStore?: ControlConfigStore;
    homeDirectory?: string;
    instanceRegistryBuilder?: InstanceRegistryBuilder;
    mcpWiringService?: McpWiringService;
    xdgRuntimeDir?: string;
}

export class ControlServer {
    readonly #configStore: ControlConfigStore;
    readonly #homeDirectory?: string;
    readonly #instanceRegistryBuilder: InstanceRegistryBuilder;
    readonly #mcpWiringService: McpWiringService;
    readonly #socketFile: ControlSocketFile;
    #artifactHostBridge?: ArtifactHostBridge;
    #artifactService?: ArtifactService;
    #config?: ControlConfig;
    #instanceRegistry = new InstanceRegistry([]);
    #mcpHost?: McpHost;
    #reverseGateway?: ReverseConnectionGateway;
    #rpcServer?: ControlRpcServer;

    constructor(options: ControlServerOptions = {}) {
        this.#configStore = options.configStore ?? new ControlConfigStore();
        this.#homeDirectory = options.homeDirectory;
        this.#instanceRegistryBuilder = options.instanceRegistryBuilder ?? new InstanceRegistryBuilder();
        this.#mcpWiringService = options.mcpWiringService ?? new McpWiringService();
        this.#socketFile = new ControlSocketFile(options.xdgRuntimeDir);
    }

    get socketPath(): string {
        return this.#socketFile.path;
    }

    get config(): ControlConfig | undefined {
        return this.#config;
    }

    async start(): Promise<void> {
        const config = await this.#configStore.readOrCreate(this.#homeDirectory);
        const registry = this.#instanceRegistryBuilder.build(config);

        await this.#socketFile.ensureRuntimeDir();

        this.#config = config;
        this.#instanceRegistry = registry;
        const setConfig = (nextConfig: ControlConfig) => {
            this.#config = nextConfig;
        };
        const instanceGatewayHolder: { value?: McpInstanceGatewayControl } = {};
        const instanceCreateService = new ControlInstanceCreateService({
            configStore: this.#configStore,
            getConfig: () => this.#requireConfig(),
            getMcpHost: () => this.#mcpHost,
            getMcpInstanceGateway: () => instanceGatewayHolder.value,
            homeDirectory: this.#homeDirectory,
            instanceRegistry: this.#instanceRegistry,
            setConfig
        });
        const instanceGateway = new McpInstanceGatewayControl({
            createService: instanceCreateService,
            getConfig: () => this.#requireConfig(),
            instanceRegistry: this.#instanceRegistry
        });
        instanceGatewayHolder.value = instanceGateway;
        const homeDirectory = this.#homeDirectory ?? homedir();
        const controlPaths = new ControlPathHome(homeDirectory);
        this.#artifactHostBridge = new ArtifactHostBridge({
            homeDirectory,
            storageDir: join(controlPaths.artifactsDir, "host")
        });
        await this.#artifactHostBridge.initialize();
        this.#artifactService = new ArtifactService({
            resolveEndpoint: (name, authorityInstance) =>
                this.#resolveArtifactEndpoint(name, authorityInstance),
            shareUrl: (token) => artifactShareUrl(this.#requireConfig(), token),
            storageDir: controlPaths.artifactsDir
        });
        await this.#artifactService.initialize();
        this.#mcpHost = this.#mcpWiringService.wire(config, registry, {
            gateway: withArtifactGateway(instanceGateway, this.#artifactService),
            storageDir: controlPaths.oauthDir
        });
        if (this.#mcpHost !== undefined) {
            new ArtifactHttpRoute(this.#artifactService, {
                publicBaseUrl: config.mcp.publicBaseUrl
            }).install(this.#mcpHost.server);
        }
        const reverseCredentialStore = new ReverseCredentialStore(this.#homeDirectory);
        let reverseControlService: ReverseControlService | undefined;
        if (config.instances.some((instance) => instance.provider === "reverse")) {
            if (this.#mcpHost === undefined || config.mcp.publicBaseUrl === undefined) {
                throw createError({
                    code: errorCodes.controlConfigValidationFailed,
                    message: "Reverse instances require enabled MCP HTTP host and mcp.publicBaseUrl.",
                    retryable: false
                });
            }
            reverseControlService = new ReverseControlService({
                credentialStore: reverseCredentialStore,
                instanceRegistry: this.#instanceRegistry,
                publicBaseUrl: config.mcp.publicBaseUrl
            });
            this.#reverseGateway = new ReverseConnectionGateway({
                credentialStore: reverseCredentialStore,
                instanceRegistry: this.#instanceRegistry,
                publicBaseUrl: config.mcp.publicBaseUrl
            });
            this.#reverseGateway.install(this.#mcpHost.server);
            reverseControlService.setDisconnectHandler((instance) => this.#reverseGateway?.disconnect(instance));
        }
        this.#rpcServer = new ControlRpcServer({
            artifactService: this.#artifactService,
            configEditorService: new ControlConfigEditorService({
                configStore: this.#configStore,
                getConfig: () => this.#requireConfig(),
                getMcpHost: () => this.#mcpHost,
                getMcpInstanceGateway: () => instanceGateway,
                homeDirectory: this.#homeDirectory,
                instanceRegistry: this.#instanceRegistry,
                setConfig
            }),
            getOAuthApprovals: () => this.#mcpHost?.oauthApprovals,
            getMcpStatus: () =>
                (this.#mcpHost as unknown as
                    | { status(): import("@portable-devshell/shared").JsonValue }
                    | undefined)?.status() ?? { running: false, reason: "MCP runtime is disabled." },
            instanceCreateService,
            instanceRegistry: this.#instanceRegistry,
            reverseControlService,
            shutdown: async () => {
                await this.stop();
            },
            restart: async () => {
                await this.stop();
                await this.start();
            },
            socketPath: this.#socketFile.path
        });

        await this.#mcpHost?.start();
        await this.#rpcServer.start();
    }

    async stop(): Promise<void> {
        this.#reverseGateway?.stop();
        await this.#mcpHost?.stop();
        await this.#artifactService?.stop();
        await this.#instanceRegistry.stopOwned();
        await this.#rpcServer?.stop();
        this.#config = undefined;
        this.#artifactService = undefined;
        this.#artifactHostBridge = undefined;
        this.#instanceRegistry = new InstanceRegistry([]);
        this.#rpcServer = undefined;
        this.#reverseGateway = undefined;
        this.#mcpHost = undefined;
    }

    #resolveArtifactEndpoint(name: string, authorityInstance?: string) {
        if (name !== "host") {
            return this.#instanceRegistry.get(name)?.worker;
        }
        if (authorityInstance === undefined || this.#artifactHostBridge === undefined) {
            return undefined;
        }
        const authority = this.#instanceRegistry.get(authorityInstance);
        if (authority === undefined) {
            return undefined;
        }
        const snapshot = authority.worker.snapshot();
        return this.#artifactHostBridge.endpointFor({
            appendControlEvent: async (type, data) =>
                await authority.worker.appendControlEvent(type, data),
            authorityInstance,
            provider: authority.provider,
            securityMode: snapshot.effectiveSecurityMode ?? "disabled",
            workspace: authority.workspace
        });
    }

    #requireConfig(): ControlConfig {
        if (this.#config !== undefined) {
            return this.#config;
        }

        throw createError({
            code: errorCodes.controlConfigLoadFailed,
            message: "Control config is not loaded.",
            retryable: false
        });
    }
}

function artifactShareUrl(config: ControlConfig, token: string): string {
    if (!config.mcp.enabled) {
        throw createError({
            code: errorCodes.controlConfigValidationFailed,
            message: "Artifact sharing requires the MCP HTTP host to be enabled.",
            retryable: false
        });
    }
    const localHost = normalizeArtifactHttpHost(config.mcp.listenHost);
    const base = new URL(config.mcp.publicBaseUrl ?? `http://${localHost}:${config.mcp.listenPort}`);
    base.pathname = `${artifactShareRoute(base.toString())}/${encodeURIComponent(token)}`;
    base.search = "";
    base.hash = "";
    return base.toString();
}

function normalizeArtifactHttpHost(host: string): string {
    if (host === "0.0.0.0" || host === "::") {
        return "127.0.0.1";
    }
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}