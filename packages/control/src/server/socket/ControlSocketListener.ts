import { createServer, type Server, type Socket } from "node:net";

import {
    removeControlIpcEndpoint,
    SocketChannel,
    type Channel
} from "@portable-devshell/shared";

import type { ControlChannelListener } from "../channel/ControlChannelServer.js";

export interface ControlSocketListenerOptions {
    socketPath: string;
}

export class ControlSocketListener implements ControlChannelListener {
    readonly #socketPath: string;
    #server?: Server;

    constructor(options: ControlSocketListenerOptions) {
        this.#socketPath = options.socketPath;
    }

    async start(accept: (channel: Channel) => void): Promise<void> {
        if (this.#server !== undefined) {
            return;
        }
        await removeControlIpcEndpoint(this.#socketPath);
        const server = createServer((socket) => accept(this.#accept(socket)));
        this.#server = server;
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(this.#socketPath, () => {
                    server.off("error", reject);
                    resolve();
                });
            });
        } catch (error) {
            this.#server = undefined;
            server.close();
            throw error;
        }
    }

    async close(): Promise<void> {
        const server = this.#server;
        this.#server = undefined;
        if (server === undefined) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined ? resolve() : reject(error));
        });
    }

    async removeEndpoint(): Promise<void> {
        await removeControlIpcEndpoint(this.#socketPath);
    }

    #accept(socket: Socket): Channel {
        return SocketChannel.accept(socket);
    }
}
