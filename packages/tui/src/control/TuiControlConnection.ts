import type { Socket } from "node:net";

import {
    ProtocolControlClientConnection,
    toControlStreamMessage,
    type ControlResponseEnvelope,
    type ProtocolControlStreamMessage
} from "@portable-devshell/shared";

export interface TuiControlConnectionOptions {
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export type TuiControlConnection = ProtocolControlClientConnection<ProtocolControlStreamMessage, Error>;

export function createTuiControlConnection(options: TuiControlConnectionOptions = {}): TuiControlConnection {
    return new ProtocolControlClientConnection({
        clientKind: "tui",
        connectionClosedMessage: { kind: "connection.closed" },
        mapConnectionError,
        mapRemoteError: toRemoteError,
        mapStreamMessage: toControlStreamMessage,
        requestIdPrefix: "tui",
        socketFactory: options.socketFactory,
        socketPath: options.socketPath,
        xdgRuntimeDir: options.xdgRuntimeDir
    });
}

function mapConnectionError(error: unknown): Error {
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = String(error.code);
        if (code === "ENOENT" || code === "ECONNREFUSED") {
            return Object.assign(new Error("control server is not running."), { code: "control.notRunning" });
        }
    }
    return error instanceof Error ? error : new Error(String(error));
}

function toRemoteError(response: ControlResponseEnvelope): Error {
    return Object.assign(new Error(response.error?.message ?? "control request failed"), {
        code: response.error?.code ?? "control.requestFailed",
        details: response.error?.details,
        retryable: response.error?.retryable
    });
}
