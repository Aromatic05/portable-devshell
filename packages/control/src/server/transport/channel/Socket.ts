import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { chmod } from "node:fs/promises";
import {
    LocalChannel,
    isWindowsNamedPipePath,
    removeControlIpcEndpoint,
} from "@portable-devshell/shared";
import type {
    ControlClientKind,
    ControlPeerSubject,
} from "@portable-devshell/shared";
import type {
    ControlAcceptedChannel,
    ControlTransportListener,
} from "./Listener.js";

export interface ControlSocketListenerOptions {
    allowedPeers?: readonly ControlClientKind[];
    socketPath: string;
    subject?: ControlPeerSubject;
}

export class ControlSocketListener implements ControlTransportListener {
    readonly #allowedPeers: readonly ControlClientKind[];
    readonly #socketPath: string;
    readonly #subject: ControlPeerSubject;
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
            channel: LocalChannel.accept(socket),
        };
    }
}

function localControlSubject(
    environment: NodeJS.ProcessEnv = process.env,
): ControlPeerSubject {
    const identity =
        typeof process.getuid === "function"
            ? `uid:${process.getuid()}`
            : `user:${environment.USERDOMAIN ?? "local"}\\${environment.USERNAME ?? environment.USER ?? "unknown"}`;
    return { id: identity, kind: "local-owner" };
}
