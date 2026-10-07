import { ControlSocketListener } from "../channel/Socket.js";
import {
    ControlTransportServer,
    type ControlTransportRouteProvider,
} from "./Server.js";

export type ControlRouteProvider = ControlTransportRouteProvider;

export interface ControlSocketServerOptions {
    onConnectionDetached?: (connectionId: string) => void;
    routes: ControlRouteProvider;
    socketPath: string;
}

export class ControlSocketServer {
    readonly #listener: ControlSocketListener;
    readonly #server: ControlTransportServer;

    constructor(options: ControlSocketServerOptions) {
        this.#listener = new ControlSocketListener({
            socketPath: options.socketPath,
        });
        this.#server = new ControlTransportServer({
            listeners: [this.#listener],
            onConnectionDetached: options.onConnectionDetached,
            routes: options.routes,
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
