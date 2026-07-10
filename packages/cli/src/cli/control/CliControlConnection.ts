import type { Socket } from "node:net";

import {
    ProtocolControlClientConnection,
    type ControlEventEnvelope,
    type ControlResponseEnvelope,
    type ControlTarget,
    type JsonValue
} from "@portable-devshell/shared";

import type { CliControlStreamCancelledEnvelope, CliControlStreamGapEnvelope } from "./CliControlRequest.js";
import { CliRenderError } from "../render/CliRenderError.js";
import type { CliControlStreamMessage } from "./CliControlStream.js";

export interface CliControlConnectionOptions {
    clientKind?: "cli" | "tui";
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export class CliControlConnection {
    readonly #connection: ProtocolControlClientConnection<CliControlStreamMessage, CliRenderError>;

    constructor(options: CliControlConnectionOptions = {}) {
        this.#connection = new ProtocolControlClientConnection({
            clientKind: options.clientKind ?? "cli",
            connectionClosedMessage: { kind: "connection.closed" },
            createRuntimeDirError: (message) => new CliRenderError("control.notRunning", message),
            mapConnectionError,
            mapRemoteError: toRemoteError,
            mapStreamMessage: toStreamMessage,
            requestIdPrefix: "cli",
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

    async nextStreamMessage(): Promise<CliControlStreamMessage> {
        return await this.#connection.nextStreamMessage();
    }

    async connect(): Promise<void> {
        await this.#connection.connect();
    }

    close(): void {
        this.#connection.close();
    }
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

function toStreamMessage(event: ControlEventEnvelope): CliControlStreamMessage {
    if (event.event === "stream.gap") {
        return {
            envelope: event as CliControlStreamGapEnvelope,
            kind: "stream.gap"
        };
    }

    if (event.event === "stream.cancelled") {
        return {
            envelope: event as CliControlStreamCancelledEnvelope,
            kind: "stream.cancelled"
        };
    }

    return {
        envelope: event,
        kind: "instance.event"
    };
}
