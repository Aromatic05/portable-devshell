import {
    ControlChannelServer,
    type ControlChannelRouteProvider
} from "../channel/ControlChannelServer.js";
import { ControlSocketChannelProvider } from "./ControlSocketChannelProvider.js";

export type ControlRouteProvider = ControlChannelRouteProvider;

export interface ControlSocketServerOptions {
    routes: ControlRouteProvider;
    socketPath: string;
}

export class ControlSocketServer {
    readonly #provider: ControlSocketChannelProvider;
    readonly #server: ControlChannelServer;

    constructor(options: ControlSocketServerOptions) {
        this.#provider = new ControlSocketChannelProvider({ socketPath: options.socketPath });
        this.#server = new ControlChannelServer({
            providers: [this.#provider],
            routes: options.routes
        });
    }

    async start(): Promise<void> {
        await this.#server.start();
    }

    async stop(): Promise<void> {
        await this.close();
        await this.removeEndpoint();
    }

    async close(): Promise<void> {
        await this.#server.close();
    }

    async removeEndpoint(): Promise<void> {
        await this.#provider.removeEndpoint();
    }
}
