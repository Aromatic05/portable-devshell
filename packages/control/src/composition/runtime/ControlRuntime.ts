import type { InstanceRegistry } from "../../control/instance/registry/InstanceRegistry.js";
import { ControlSocketServer } from "../../server/socket/ControlSocketServer.js";
import { ControlRouteComposition } from "../ControlRouteComposition.js";
import type { ControlRuntimeArtifact } from "./ControlRuntimeArtifact.js";
import type { ControlRuntimeMcp } from "./ControlRuntimeMcp.js";
import type { ControlRuntimeReverse } from "./ControlRuntimeReverse.js";

export interface ControlRuntimeOptions {
    artifact: ControlRuntimeArtifact;
    instances: InstanceRegistry;
    mcp: ControlRuntimeMcp;
    restart: () => Promise<void>;
    reverse: ControlRuntimeReverse;
    shutdown: () => Promise<void>;
    socketPath: string;
}

export class ControlRuntime {
    readonly #artifact: ControlRuntimeArtifact;
    readonly #instances: InstanceRegistry;
    readonly #mcp: ControlRuntimeMcp;
    readonly #reverse: ControlRuntimeReverse;
    readonly #routes: ControlRouteComposition;
    readonly #socket: ControlSocketServer;

    constructor(options: ControlRuntimeOptions) {
        this.#artifact = options.artifact;
        this.#instances = options.instances;
        this.#mcp = options.mcp;
        this.#reverse = options.reverse;
        this.#routes = new ControlRouteComposition({
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
        await this.#socket.stop();
        await this.#artifact.stop();
        await this.#instances.stopOwned();
        this.#routes.dispose();
    }
}
