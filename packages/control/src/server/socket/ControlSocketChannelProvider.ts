import { createServer, type Server, type Socket } from "node:net";

import {
    Channel,
    removeControlIpcEndpoint,
    type FrameChannel
} from "@portable-devshell/shared";

import type { ControlChannelProvider } from "../channel/ControlChannelServer.js";

export interface ControlSocketChannelProviderOptions {
    socketPath: string;
}

export class ControlSocketChannelProvider implements ControlChannelProvider {
    readonly #socketPath: string;
    #server?: Server;

    constructor(options: ControlSocketChannelProviderOptions) {
        this.#socketPath = options.socketPath;
    }

    async start(accept: (channel: FrameChannel) => void): Promise<void> {
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

    #accept(socket: Socket): FrameChannel {
        return Channel.accept(socket);
    }
}
