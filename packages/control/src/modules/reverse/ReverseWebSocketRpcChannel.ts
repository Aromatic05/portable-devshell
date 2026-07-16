import { WorkerRpcChannelBase } from "@portable-devshell/core";
import type { JsonValue } from "@portable-devshell/shared";
import WebSocket, { type RawData } from "ws";

import { ReverseRpcFrameCodec } from "./ReverseRpcFrameCodec.js";

const HEARTBEAT_INTERVAL_MS = 20_000;
const DEAD_CONNECTION_MS = 60_000;

export class ReverseWebSocketRpcChannel extends WorkerRpcChannelBase {
    readonly #socket: WebSocket;
    readonly #heartbeat: NodeJS.Timeout;
    readonly #pendingRequestIds = new Set<string>();
    #lastSeenAt = Date.now();

    constructor(socket: WebSocket) {
        super();
        this.#socket = socket;
        socket.on("message", this.#handleMessage);
        socket.on("pong", () => { this.#lastSeenAt = Date.now(); });
        socket.once("close", (code, reason) => {
            this.#disconnect(new Error(`reverse websocket closed: ${code} ${reason.toString()}`));
        });
        socket.once("error", (error) => this.#disconnect(error));
        this.#heartbeat = setInterval(() => this.#heartbeatTick(), HEARTBEAT_INTERVAL_MS);
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
        await new Promise<void>((resolve, reject) => {
            this.#socket.send(frame, { binary: true }, (error) => {
                if (error == null) {
                    resolve();
                    return;
                }
                if (requestId !== undefined) {
                    this.#pendingRequestIds.delete(requestId);
                }
                reject(error);
            });
        });
    }

    close(): void {
        if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
            this.#socket.close(1000, "connection superseded");
        }
        this.#disconnect(new Error("reverse websocket channel closed"));
    }

    readonly #handleMessage = (data: RawData, isBinary: boolean): void => {
        this.#lastSeenAt = Date.now();
        if (!isBinary) {
            this.#socket.close(1003, "binary RPC frame required");
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
            this.#socket.close(1007, "invalid RPC frame");
            this.#disconnect(error);
        }
    };

    #heartbeatTick(): void {
        if (this.disconnected) {
            return;
        }
        if (this.#pendingRequestIds.size === 0 && Date.now() - this.#lastSeenAt >= DEAD_CONNECTION_MS) {
            this.#socket.terminate();
            this.#disconnect(new Error("reverse websocket heartbeat timed out"));
            return;
        }
        if (this.#socket.readyState === WebSocket.OPEN) {
            this.#socket.ping();
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
