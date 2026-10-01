import type { ControlClientKind } from "../protocol/control/ControlProtocol.js";
import type { Channel } from "../transport/endpoint/channel/Channel.js";
import { Endpoint } from "../transport/endpoint/Endpoint.js";
import { createControlClients, type ControlClients } from "./ControlClients.js";

export interface PersistentControlClients extends ControlClients {
    close(): void;
    onTransportClose(listener: (error?: Error) => void): () => void;
    reconnect(): Promise<void>;
}

export interface PersistentControlClientOptions {
    clientKind: ControlClientKind;
    connectChannel(signal?: AbortSignal): Promise<Channel>;
}

export function createPersistentControlClients(
    options: PersistentControlClientOptions,
): PersistentControlClients {
    const endpoint = new Endpoint({ connectChannel: options.connectChannel });
    return {
        ...createControlClients(endpoint, { clientKind: options.clientKind }),
        close: () => endpoint.close(),
        onTransportClose: (listener) => endpoint.onTransportClose(listener),
        reconnect: () => endpoint.reconnect(),
    };
}
