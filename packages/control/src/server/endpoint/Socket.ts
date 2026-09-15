import { ControlChannelServer } from "./Channel.js";
import type {
    ControlAcceptedChannel,
    ControlChannelListener,
    ControlChannelRouteProvider,
} from "./Channel.js";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { chmod } from "node:fs/promises";
import {
    SocketChannel,
    isWindowsNamedPipePath,
    removeControlIpcEndpoint,
} from "@portable-devshell/shared";
import type {
    ControlClientKind,
    PrefixRouteSubject,
} from "@portable-devshell/shared";

export type ControlRouteProvider = ControlChannelRouteProvider;

export interface ControlSocketServerOptions {
    routes: ControlRouteProvider;
    socketPath: string;
}

export class ControlSocketServer {
    readonly #listener: ControlSocketListener;
    readonly #server: ControlChannelServer;

    constructor(options: ControlSocketServerOptions) {
        this.#listener = new ControlSocketListener({
            socketPath: options.socketPath,
        });
        this.#server = new ControlChannelServer({
            listeners: [this.#listener],
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

export interface ControlSocketListenerOptions {
    allowedPeers?: readonly ControlClientKind[];
    socketPath: string;
    subject?: PrefixRouteSubject;
}

export class ControlSocketListener implements ControlChannelListener {
    readonly #allowedPeers: readonly ControlClientKind[];
    readonly #socketPath: string;
    readonly #subject: PrefixRouteSubject;
    #server?: Server;

    constructor(options: ControlSocketListenerOptions) {
        this.#allowedPeers = options.allowedPeers ?? ["cli", "tui"];
        this.#socketPath = options.socketPath;
        this.#subject = options.subject ?? localControlSubject();
    }

    async start(
        accept: (connection: ControlAcceptedChannel) => void,
    ): Promise<void> {
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
            if (!isWindowsNamedPipePath(this.#socketPath)) {
                await chmod(this.#socketPath, 0o600);
            }
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
            server.close((error) =>
                error === undefined ? resolve() : reject(error),
            );
        });
    }

    async removeEndpoint(): Promise<void> {
        await removeControlIpcEndpoint(this.#socketPath);
    }

    #accept(socket: Socket): ControlAcceptedChannel {
        return {
            admission: {
                allowedPeers: this.#allowedPeers,
                subject: this.#subject,
            },
            channel: SocketChannel.accept(socket),
        };
    }
}

function localControlSubject(
    environment: NodeJS.ProcessEnv = process.env,
): PrefixRouteSubject {
    const identity =
        typeof process.getuid === "function"
            ? `uid:${process.getuid()}`
            : `user:${environment.USERDOMAIN ?? "local"}\\${environment.USERNAME ?? environment.USER ?? "unknown"}`;
    return { id: identity, kind: "local-owner" };
}
