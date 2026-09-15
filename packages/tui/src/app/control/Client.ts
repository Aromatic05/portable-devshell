import {
    connectControlClientChannel,
    createPersistentControlClients,
    type ControlClientChannelOptions,
    type ControlErrorBody,
    type PersistentControlClients,
} from "@portable-devshell/shared";

export interface TuiClientOptions extends ControlClientChannelOptions {}
export type TuiClients = PersistentControlClients;

export function createTuiClients(options: TuiClientOptions = {}): TuiClients {
    return createPersistentControlClients({
        clientKind: "tui",
        connectChannel: async (signal) => await connectControlClientChannel(options, signal),
        mapError: toClientError,
        mapRemoteError: toRemoteError,
        peer: "tui",
    });
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
