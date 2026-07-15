import type { Socket } from "node:net";

import {
    ProtocolControlClientConnection,
    toControlStreamMessage,
    type ControlResponseEnvelope,
    type ProtocolControlStreamMessage
} from "@portable-devshell/shared";

import { CliRenderError } from "../render/CliRenderError.js";

export interface CliControlConnectionOptions {
    clientKind?: "cli" | "tui";
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export type CliControlConnection = ProtocolControlClientConnection<ProtocolControlStreamMessage, CliRenderError>;

export function createCliControlConnection(options: CliControlConnectionOptions = {}): CliControlConnection {
    return new ProtocolControlClientConnection({
        clientKind: options.clientKind ?? "cli",
        connectionClosedMessage: { kind: "connection.closed" },
        mapConnectionError,
        mapRemoteError: toRemoteError,
        mapStreamMessage: toControlStreamMessage,
        requestIdPrefix: "cli",
        socketFactory: options.socketFactory,
        socketPath: options.socketPath,
        xdgRuntimeDir: options.xdgRuntimeDir
    });
}

function mapConnectionError(error: unknown): CliRenderError {
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = String(error.code);
        if (code === "ENOENT" || code === "ECONNREFUSED") {
            return new CliRenderError("control.notRunning", "control server is not running.");
        }
    }
    return new CliRenderError("control.notRunning", error instanceof Error ? error.message : String(error));
}

function toRemoteError(response: ControlResponseEnvelope): CliRenderError {
    return new CliRenderError(response.error?.code ?? "control.requestFailed", response.error?.message ?? "control request failed", {
        cause: response.error?.cause,
        details: response.error?.details,
        retryable: response.error?.retryable
    });
}
