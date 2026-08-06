import {
    ControlChannelServer,
    type ControlChannelRouteProvider
} from "../channel/ControlChannelServer.js";
import { ControlSocketListener } from "./ControlSocketListener.js";

export type ControlRouteProvider = ControlChannelRouteProvider;

export interface ControlSocketServerOptions {
    routes: ControlRouteProvider;
    socketPath: string;
}

export class ControlSocketServer {
    readonly #listener: ControlSocketListener;
    readonly #server: ControlChannelServer;

    constructor(options: ControlSocketServerOptions) {
        this.#listener = new ControlSocketListener({ socketPath: options.socketPath });
        this.#server = new ControlChannelServer({
            listeners: [this.#listener],
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
        await this.#listener.removeEndpoint();
    }
}
