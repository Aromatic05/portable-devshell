import type { InstanceRegistry } from "../../modules/instance/registry/InstanceRegistry.js";
import { ControlSocketServer } from "../../control/socket/ControlSocketServer.js";
import { RouteComposition } from "../RouteComposition.js";
import type { ArtifactRuntime } from "./ArtifactRuntime.js";
import type { McpRuntime } from "./McpRuntime.js";
import type { ReverseRuntime } from "./ReverseRuntime.js";

export interface ControlRuntimeOptions {
    artifact: ArtifactRuntime;
    instances: InstanceRegistry;
    mcp: McpRuntime;
    restart: () => Promise<void>;
    reverse: ReverseRuntime;
    shutdown: () => Promise<void>;
    socketPath: string;
}

export class ControlRuntime {
    readonly #artifact: ArtifactRuntime;
    readonly #instances: InstanceRegistry;
    readonly #mcp: McpRuntime;
    readonly #reverse: ReverseRuntime;
    readonly #routes: RouteComposition;
    readonly #socket: ControlSocketServer;

    constructor(options: ControlRuntimeOptions) {
        this.#artifact = options.artifact;
        this.#instances = options.instances;
        this.#mcp = options.mcp;
        this.#reverse = options.reverse;
        this.#routes = new RouteComposition({
            artifact: options.artifact.service,
            config: options.mcp.configEditor,
            instanceCreate: options.mcp.instanceCreate,
            instances: options.instances,
            mcpStatus: () => options.mcp.status(),
            oauthApprovals: () => options.mcp.oauthApprovals,
            restart: options.restart,
            reverse: options.reverse.service,
            shutdown: options.shutdown
        });
        this.#socket = new ControlSocketServer({ routes: this.#routes, socketPath: options.socketPath });
    }

    async start(): Promise<void> {
        try {
            await this.#mcp.start();
            await this.#socket.start();
        } catch (error) {
            await this.stop().catch(() => undefined);
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.#reverse.stop();
        await this.#mcp.stop();
        await this.#artifact.stop();
        await this.#instances.stopOwned();
        await this.#socket.stop();
        this.#routes.dispose();
    }
}
