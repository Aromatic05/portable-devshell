import { createError, errorCodes } from "@portable-devshell/shared";
import type { McpHost } from "@portable-devshell/mcp";

import { ControlInstanceCreateService } from "./ControlInstanceCreateService.js";
import { ControlConfigEditorService } from "./ControlConfigEditorService.js";
import { ControlConfigStore } from "./config/ControlConfigStore.js";
import type { ControlConfig } from "./config/ControlConfigTomlCodec.js";
import { ControlPathHome } from "./path/ControlPathHome.js";
import { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";
import { InstanceRegistryBuilder } from "../instance/registry/InstanceRegistryBuilder.js";
import { McpInstanceGatewayControl } from "../mcp/McpInstanceGatewayControl.js";
import { McpWiringService } from "../mcp/McpWiringService.js";
import { ControlRpcServer } from "./rpc/ControlRpcServer.js";
import { ControlSocketFile } from "./ControlSocketFile.js";

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
    #config?: ControlConfig;
    #instanceRegistry = new InstanceRegistry([]);
    #mcpHost?: McpHost;
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
        this.#mcpHost = this.#mcpWiringService.wire(config, registry, {
            gateway: instanceGateway,
            storageDir: new ControlPathHome(this.#homeDirectory).oauthDir
        });
        this.#rpcServer = new ControlRpcServer({
            configEditorService: new ControlConfigEditorService({
                configStore: this.#configStore,
                getConfig: () => this.#requireConfig(),
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
        await this.#mcpHost?.stop();
        await this.#instanceRegistry.stopOwned();
        await this.#rpcServer?.stop();
        this.#config = undefined;
        this.#instanceRegistry = new InstanceRegistry([]);
        this.#rpcServer = undefined;
        this.#mcpHost = undefined;
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
