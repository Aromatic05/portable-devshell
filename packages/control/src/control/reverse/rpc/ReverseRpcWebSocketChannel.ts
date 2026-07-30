import { WorkerRpcChannelBase } from "@portable-devshell/core";
import type { JsonValue } from "@portable-devshell/shared";
import WebSocket, { type RawData } from "ws";

import { ReverseRpcFrameCodec } from "./ReverseRpcFrameCodec.js";

const HEARTBEAT_INTERVAL_MS = 20_000;
const DEAD_CONNECTION_MS = 60_000;

export interface ReverseRpcWebSocketChannelOptions {
    deadConnectionMs?: number;
    heartbeatIntervalMs?: number;
    now?: () => number;
}

export class ReverseRpcWebSocketChannel extends WorkerRpcChannelBase {
    readonly #deadConnectionMs: number;
    readonly #socket: WebSocket;
    readonly #heartbeat: NodeJS.Timeout;
    readonly #now: () => number;
    readonly #pendingRequestIds = new Set<string>();
    #lastSeenAt: number;

    constructor(socket: WebSocket, options: ReverseRpcWebSocketChannelOptions = {}) {
        super();
        this.#deadConnectionMs = options.deadConnectionMs ?? DEAD_CONNECTION_MS;
        this.#now = options.now ?? Date.now;
        this.#socket = socket;
        this.#lastSeenAt = this.#now();
        socket.on("message", this.#handleMessage);
        socket.on("pong", () => { this.#lastSeenAt = this.#now(); });
        socket.once("close", (code, reason) => {
            this.#disconnect(new Error(`reverse websocket closed: ${code} ${reason.toString()}`));
        });
        socket.once("error", (error) => this.#disconnect(error));
        this.#heartbeat = setInterval(
            () => this.#heartbeatTick(),
            options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
        );
        this.#heartbeat.unref();
    }

    async send(message: JsonValue): Promise<void> {
        if (this.disconnected || this.#socket.readyState !== WebSocket.OPEN) {
            throw new Error("reverse websocket is disconnected");
        }
        const frame = ReverseRpcFrameCodec.encode(message);
        const requestId = readEnvelopeId(message, "request");
        if (requestId !== undefined) {
            this.#pendingRequestIds.add(requestId);
        }
        try {
            await new Promise<void>((resolve, reject) => {
                this.#socket.send(frame, { binary: true }, (error) => {
                    if (error == null) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
        } catch (error) {
            if (requestId !== undefined) {
                this.#pendingRequestIds.delete(requestId);
            }
            this.#fail(error);
            throw error instanceof Error ? error : new Error(String(error));
        }
    }

    close(): void {
        try {
            if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
                this.#socket.close(1000, "connection superseded");
            }
        } catch (error) {
            this.#fail(error);
            return;
        }
        this.#disconnect(new Error("reverse websocket channel closed"));
    }

    readonly #handleMessage = (data: RawData, isBinary: boolean): void => {
        this.#lastSeenAt = this.#now();
        if (!isBinary) {
            this.#closeInvalid(1003, "binary RPC frame required", new Error("reverse websocket requires binary RPC frames"));
            return;
        }
        try {
            const frame = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(data as ArrayBuffer);
            const message = ReverseRpcFrameCodec.decode(frame);
            const responseId = readEnvelopeId(message, "response");
            if (responseId !== undefined) {
                this.#pendingRequestIds.delete(responseId);
            }
            this.emitMessage(message);
        } catch (error) {
            this.#closeInvalid(1007, "invalid RPC frame", error);
        }
    };

    #heartbeatTick(): void {
        if (this.disconnected) {
            return;
        }
        if (this.#now() - this.#lastSeenAt >= this.#deadConnectionMs) {
            this.#fail(new Error("reverse websocket heartbeat timed out"));
            return;
        }
        if (this.#socket.readyState === WebSocket.OPEN) {
            try {
                this.#socket.ping();
            } catch (error) {
                this.#fail(error);
            }
        }
    }

    #closeInvalid(code: number, reason: string, error: unknown): void {
        try {
            this.#socket.close(code, reason);
        } catch {
            // Disconnect below owns the lifecycle even if the close frame cannot be sent.
        }
        this.#disconnect(error);
    }

    #fail(error: unknown): void {
        this.#disconnect(error);
        try {
            this.#socket.terminate();
        } catch {
            // The channel is already disconnected locally; transport teardown is best effort.
        }
    }

    #disconnect(error: unknown): void {
        this.notifyDisconnect(error, () => {
            this.#pendingRequestIds.clear();
            clearInterval(this.#heartbeat);
        });
    }
}

function readEnvelopeId(value: JsonValue, type: "request" | "response"): string | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value as Record<string, JsonValue>;
    return candidate.type === type && typeof candidate.id === "string" ? candidate.id : undefined;
}
