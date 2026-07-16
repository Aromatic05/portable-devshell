import type { Socket } from "node:net";

import type { ControlErrorBody } from "../error/ErrorBodyControl.js";
import { resolveControlSocketPath } from "../runtime/RuntimeControlPath.js";
import { Channel } from "../transport/Channel.js";
import { Codec, type Destination, type Event, type Frame, type Peer } from "../transport/Codec.js";
import { PrefixRoute } from "../transport/PrefixRoute.js";
import type { JsonValue } from "../type/TypeJsonValue.js";

export interface ClientConnectionOptions {
    mapError(error: unknown): Error;
    mapRemoteError(error: ControlErrorBody): Error;
    peer: Exclude<Peer, "server">;
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export interface OpenedClientStream {
    acknowledgement: Frame;
    route: PrefixRoute;
}

export class ClientConnection {
    readonly #mapError: (error: unknown) => Error;
    readonly #mapRemoteError: (error: ControlErrorBody) => Error;
    readonly #peer: Exclude<Peer, "server">;
    readonly #socketFactory?: (path: string) => Socket;
    readonly #socketPath: string;

    constructor(options: ClientConnectionOptions) {
        this.#mapError = options.mapError;
        this.#mapRemoteError = options.mapRemoteError;
        this.#peer = options.peer;
        this.#socketFactory = options.socketFactory;
        this.#socketPath = options.socketPath ?? resolveControlSocketPath(options.xdgRuntimeDir);
    }

    async request<TResult>(
        destination: Destination,
        module: string,
        operation: string,
        payload?: unknown
    ): Promise<TResult> {
        const route = await this.#connect();
        try {
            const reply = await route.request({
                destination,
                name: operationName(module, operation),
                ...(payload === undefined ? {} : { payload: payload as JsonValue })
            });
            this.throwRemoteError(reply.event.error);
            return reply.event.payload as unknown as TResult;
        } catch (error) {
            throw this.mapError(error);
        } finally {
            route.close();
        }
    }

    async openStream(
        destination: Destination,
        module: string,
        operation: string,
        payload?: unknown
    ): Promise<OpenedClientStream> {
        const route = await this.#connect();
        try {
            const acknowledgement = await route.openStream({
                destination,
                name: operationName(module, operation),
                ...(payload === undefined ? {} : { payload: payload as JsonValue })
            });
            this.throwRemoteError(acknowledgement.event.error);
            return { acknowledgement, route };
        } catch (error) {
            route.close();
            throw this.mapError(error);
        }
    }

    throwRemoteError(error: ControlErrorBody | undefined): void {
        if (error !== undefined) {
            throw this.#mapRemoteError(error);
        }
    }

    mapError(error: unknown): Error {
        return this.#mapError(error);
    }

    async #connect(): Promise<PrefixRoute> {
        try {
            const channel = await Channel.connect(this.#socketPath, { socketFactory: this.#socketFactory });
            return new PrefixRoute(new Codec(channel, { local: this.#peer, remote: "server" }), {
                requestIdPrefix: this.#peer
            });
        } catch (error) {
            throw this.mapError(error);
        }
    }
}

function operationName(module: string, operation: string): Event["name"] {
    return `${module}.${operation}`;
}
