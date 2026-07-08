import type { McpHost } from "@portable-devshell/mcp";

import { ControlConfigStore } from "./config/ControlConfigStore.js";
import type { ControlConfig } from "./config/ControlConfigTomlCodec.js";
import { InstanceRegistryBuilder } from "../instance/registry/InstanceRegistryBuilder.js";
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
        this.#mcpHost = this.#mcpWiringService.wire(config, registry);
        this.#rpcServer = new ControlRpcServer({
            instanceRegistry: registry,
            shutdown: async () => {
                await this.stop();
            },
            socketPath: this.#socketFile.path
        });

        await this.#mcpHost?.start();
        await this.#rpcServer.start();
    }

    async stop(): Promise<void> {
        await this.#rpcServer?.stop();
        await this.#mcpHost?.stop();
        this.#rpcServer = undefined;
        this.#mcpHost = undefined;
    }
}
