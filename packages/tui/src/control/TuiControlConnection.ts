import type { Socket } from "node:net";

import {
    ProtocolControlClientConnection,
    type ControlResponseEnvelope,
    type ControlTarget,
    type JsonValue
} from "@portable-devshell/shared";

import type { TuiControlEventEnvelope } from "./TuiControlRequest.js";
import { TuiControlStream, type TuiControlStreamMessage, toStreamMessage } from "./TuiControlStream.js";

export interface TuiControlConnectionOptions {
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export class TuiControlConnection {
    readonly #connection: ProtocolControlClientConnection<TuiControlStreamMessage, Error>;

    constructor(options: TuiControlConnectionOptions = {}) {
        this.#connection = new ProtocolControlClientConnection({
            clientKind: "tui",
            connectionClosedMessage: { kind: "connection.closed" },
            mapConnectionError,
            mapRemoteError: toRemoteError,
            mapStreamMessage: toStreamMessage,
            requestIdPrefix: "tui",
            socketFactory: options.socketFactory,
            socketPath: options.socketPath,
            xdgRuntimeDir: options.xdgRuntimeDir
        });
    }

    async request(method: string, target: ControlTarget, params?: JsonValue): Promise<JsonValue> {
        return await this.#connection.request(method, target, params);
    }

    async requestWithRelay(
        method: string,
        target: ControlTarget,
        relay: { onOutput(chunk: string): void; onRequestId?(requestId: string): void },
        params?: JsonValue
    ): Promise<JsonValue> {
        return await this.#connection.requestWithRelay(method, target, relay, params);
    }

    async sendRelayInput(requestId: string, chunk: Uint8Array): Promise<void> {
        await this.#connection.sendRelayInput(requestId, chunk);
    }

    async sendRelayEof(requestId: string): Promise<void> {
        await this.#connection.sendRelayEof(requestId);
    }

    async nextStreamMessage(): Promise<TuiControlStreamMessage> {
        return await this.#connection.nextStreamMessage();
    }

    async connect(): Promise<void> {
        await this.#connection.connect();
    }

    close(): void {
        this.#connection.close();
    }
}

export function createSubscribedStream(
    connection: TuiControlConnection,
    initialEvents: TuiControlEventEnvelope[]
): TuiControlStream {
    return new TuiControlStream(connection, initialEvents);
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
