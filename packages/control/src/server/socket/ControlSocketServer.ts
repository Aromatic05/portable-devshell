import { createServer, type Server, type Socket } from "node:net";

import { Channel, Codec, PrefixRoute, type PrefixRouteSnapshot } from "@portable-devshell/shared";

import { removeControlIpcEndpoint } from "@portable-devshell/shared";

export interface ControlRouteProvider {
    connectionClosed(connectionId: string): void;
    snapshot(): PrefixRouteSnapshot;
}

export interface ControlSocketServerOptions {
    routes: ControlRouteProvider;
    socketPath: string;
}

export class ControlSocketServer {
    readonly #routes: ControlRouteProvider;
    readonly #socketPath: string;
    readonly #connections = new Map<string, PrefixRoute>();
    #server?: Server;
    #stopPromise?: Promise<void>;

    constructor(options: ControlSocketServerOptions) {
        this.#routes = options.routes;
        this.#socketPath = options.socketPath;
    }

    async start(): Promise<void> {
        await removeControlIpcEndpoint(this.#socketPath);
        this.#server = createServer((socket) => this.#attach(socket));
        await new Promise<void>((resolve, reject) => {
            this.#server?.once("error", reject);
            this.#server?.listen(this.#socketPath, () => {
                this.#server?.off("error", reject);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (this.#stopPromise !== undefined) return await this.#stopPromise;
        this.#stopPromise = this.#stopInternal();
        try {
            await this.#stopPromise;
        } finally {
            this.#stopPromise = undefined;
        }
    }

    #attach(socket: Socket): void {
        const channel = Channel.accept(socket);
        const route = new PrefixRoute(new Codec(channel, { local: "server" }), {
            eventIdPrefix: "server",
            getSnapshot: () => this.#routes.snapshot(),
        });
        this.#connections.set(route.connectionId, route);
        channel.onClose(() => {
            this.#connections.delete(route.connectionId);
            this.#routes.connectionClosed(route.connectionId);
        });
    }

    async #stopInternal(): Promise<void> {
        for (const route of this.#connections.values()) route.close();
        this.#connections.clear();
        const server = this.#server;
        this.#server = undefined;
        if (server !== undefined) {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined ? resolve() : reject(error));
            });
        }
        await removeControlIpcEndpoint(this.#socketPath);
    }
}
