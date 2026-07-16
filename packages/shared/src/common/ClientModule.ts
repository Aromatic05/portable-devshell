import { asInstanceName } from "../type/identity/TypeIdentityInstanceName.js";
import type { ClientConnection, OpenedClientStream } from "./ClientConnection.js";

export interface ControlClientModule {
    openStream(operation: string, payload?: unknown): Promise<OpenedClientStream>;
    request<TResult>(operation: string, payload?: unknown): Promise<TResult>;
}

export interface InstanceClientModule {
    openStream(instance: string, operation: string, payload?: unknown): Promise<OpenedClientStream>;
    request<TResult>(instance: string, operation: string, payload?: unknown): Promise<TResult>;
}

export function controlClientModule(connection: ClientConnection, module: string): ControlClientModule {
    return {
        openStream: (operation, payload) => connection.openStream("@control", module, operation, payload),
        request: (operation, payload) => connection.request("@control", module, operation, payload)
    };
}

export function instanceClientModule(connection: ClientConnection, module: string): InstanceClientModule {
    return {
        openStream: (instance, operation, payload) => connection.openStream(asInstanceName(instance), module, operation, payload),
        request: (instance, operation, payload) => connection.request(asInstanceName(instance), module, operation, payload)
    };
}
