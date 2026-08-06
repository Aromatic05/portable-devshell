import {
    ClientConnection,
    connectControlClientChannel,
    createControlClients,
    type ControlClientChannelOptions,
    type ControlClients,
    type ControlErrorBody,
} from "@portable-devshell/shared";

export interface TuiClientOptions extends ControlClientChannelOptions {}

export interface TuiClients extends ControlClients {
    close(): void;
    reconnect(): Promise<void>;
}

export function createTuiClients(options: TuiClientOptions = {}): TuiClients {
    const connection = new ClientConnection({
        connectChannel: (signal) => connectControlClientChannel(options, signal),
        mode: "persistent",
        peer: "tui",
        mapError: toClientError,
        mapRemoteError: toRemoteError,
    });
    return {
        ...createControlClients(connection, { clientKind: "tui" }),
        close: () => connection.close(),
        reconnect: async () => await connection.reconnect(),
    };
}

function toRemoteError(error: ControlErrorBody): Error {
    return Object.assign(new Error(error.message), {
        code: error.code,
        details: error.details,
        retryable: error.retryable,
    });
}

function toClientError(error: unknown): Error {
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = String(error.code);
        if (code === "ENOENT" || code === "ECONNREFUSED") {
            return Object.assign(new Error("control server is not running."), {
                code: "control.notRunning",
            });
        }
    }
    return error instanceof Error ? error : new Error(String(error));
}
