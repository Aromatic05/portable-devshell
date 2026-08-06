import type { ControlClientKind } from "../dto/DtoControlProtocol.js";
import type { ControlErrorBody } from "../error/ErrorBodyControl.js";
import {
    ClientConnection,
    type ClientConnectionOptions,
} from "../transport/ClientConnection.js";
import type { Channel } from "../transport/protocol/Channel.js";
import { createControlClients, type ControlClients } from "./ControlClients.js";

export interface PersistentControlClients extends ControlClients {
    close(): void;
    onTransportClose(listener: (error: Error) => void): () => void;
    reconnect(): Promise<void>;
}

export interface PersistentControlClientOptions {
    clientKind: ControlClientKind;
    connectChannel(signal?: AbortSignal): Promise<Channel>;
    mapError(error: unknown): Error;
    mapRemoteError(error: ControlErrorBody): Error;
    peer: Exclude<ClientConnectionOptions["peer"], "server">;
}

export function createPersistentControlClients(
    options: PersistentControlClientOptions,
): PersistentControlClients {
    const connection = new ClientConnection({
        connectChannel: options.connectChannel,
        mapError: options.mapError,
        mapRemoteError: options.mapRemoteError,
        mode: "persistent",
        peer: options.peer,
    });
    return {
        ...createControlClients(connection, { clientKind: options.clientKind }),
        close: () => connection.close(),
        onTransportClose: (listener) => connection.onTransportClose(listener),
        reconnect: async () => await connection.reconnect(),
    };
}
