import { createConnection, type Socket } from "node:net";
import { resolveControlSocketPath } from "../runtime/RuntimeControlPath.js";

import type { ControlEventEnvelope, ControlRelayInputEnvelope, ControlResponseEnvelope } from "./envelope/ProtocolEnvelopeControl.js";
import type { ControlTarget } from "./envelope/ProtocolEnvelopeTarget.js";
import { FrameReader } from "./frame/ProtocolFrameReader.js";
import { FrameWriter } from "./frame/ProtocolFrameWriter.js";
import type { JsonValue } from "../type/TypeJsonValue.js";

export interface ProtocolControlClientConnectionOptions<TStreamMessage, TError extends Error> {
    clientKind: "cli" | "tui";
    connectionClosedMessage: TStreamMessage;
    mapConnectionError(error: unknown): TError;
    mapRemoteError(response: ControlResponseEnvelope): TError;
    mapStreamMessage(event: ControlEventEnvelope): TStreamMessage;
    requestIdPrefix: string;
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export class ProtocolControlClientConnection<TStreamMessage, TError extends Error> {
    readonly #clientKind: "cli" | "tui";
    readonly #connectionClosedMessage: TStreamMessage;
    readonly #mapConnectionError: (error: unknown) => TError;
    readonly #mapRemoteError: (response: ControlResponseEnvelope) => TError;
    readonly #mapStreamMessage: (event: ControlEventEnvelope) => TStreamMessage;
    readonly #reader = new FrameReader();
    readonly #requestIdPrefix: string;
    readonly #socketFactory: (path: string) => Socket;
    readonly #socketPath: string;
    readonly #pending = new Map<
        string,
        { method: string; reject: (error: unknown) => void; resolve: (value: JsonValue) => void }
    >();
    readonly #relayOutputs = new Map<string, (chunk: string) => void>();
    readonly #streamMessages: TStreamMessage[] = [];
    readonly #streamWaiters: Array<{ resolve: (value: TStreamMessage) => void }> = [];
    #connected = false;
    #connectionClosed = false;
    #counter = 0;
    #socketError?: Error;
    #socket?: Socket;
    #writer?: FrameWriter;

    constructor(options: ProtocolControlClientConnectionOptions<TStreamMessage, TError>) {
        this.#clientKind = options.clientKind;
        this.#connectionClosedMessage = options.connectionClosedMessage;
        this.#mapConnectionError = options.mapConnectionError;
        this.#mapRemoteError = options.mapRemoteError;
        this.#mapStreamMessage = options.mapStreamMessage;
        this.#requestIdPrefix = options.requestIdPrefix;
        this.#socketFactory = options.socketFactory ?? createConnection;
        this.#socketPath = options.socketPath ?? this.#resolveDefaultSocketPath(options.xdgRuntimeDir);
    }

    async request(method: string, target: ControlTarget, params?: JsonValue): Promise<JsonValue> {
        await this.connect();
        return await this.#requestConnected(method, target, params);
    }

    async requestWithRelay(
        method: string,
        target: ControlTarget,
        relay: { onOutput(chunk: string): void; onRequestId?(requestId: string): void },
        params?: JsonValue
    ): Promise<JsonValue> {
        await this.connect();
        return await this.#requestConnected(method, target, params, relay.onOutput, relay.onRequestId);
    }

    async sendRelayInput(requestId: string, chunk: Uint8Array): Promise<void> {
        await this.connect();
        await this.#writer?.write({
            data: Buffer.from(chunk).toString("base64"),
            id: requestId,
            type: "relay.input"
        } satisfies ControlRelayInputEnvelope as unknown as JsonValue);
    }

    async sendRelayEof(requestId: string): Promise<void> {
        await this.connect();
        await this.#writer?.write({
            eof: true,
            id: requestId,
            type: "relay.input"
        } satisfies ControlRelayInputEnvelope as unknown as JsonValue);
    }

    async nextStreamMessage(): Promise<TStreamMessage> {
        const message = this.#streamMessages.shift();

        if (message !== undefined) {
            return message;
        }

        if (this.#connectionClosed) {
            return this.#connectionClosedMessage;
        }

        await this.connect();

        return await new Promise<TStreamMessage>((resolve) => {
            this.#streamWaiters.push({ resolve });
        });
    }

    async connect(): Promise<void> {
        if (this.#connected) {
            return;
        }

        const socket = this.#socketFactory(this.#socketPath);
        this.#socketError = undefined;
        this.#socket = socket;
        this.#writer = new FrameWriter(socket);

        await new Promise<void>((resolve, reject) => {
            socket.once("connect", () => {
                this.#connected = true;
                this.#connectionClosed = false;
                resolve();
            });
            socket.once("error", (error) => {
                reject(this.#mapConnectionError(error));
            });
        });

        socket.on("data", (chunk: Uint8Array) => {
            for (const frame of this.#reader.push(chunk)) {
                this.#accept(frame);
            }
        });
        socket.once("close", () => {
            this.#connected = false;
            this.#connectionClosed = true;
            this.#failPending(this.#createConnectionClosedError());
            this.#pushStreamMessage(this.#connectionClosedMessage);
        });
        socket.once("error", (error) => {
            this.#connected = false;
            this.#connectionClosed = true;
            this.#socketError = error;
            this.#failPending(error);
            this.#pushStreamMessage(this.#connectionClosedMessage);
        });

        await this.#requestConnected("control.identifyClient", { kind: "control" }, { clientKind: this.#clientKind });
    }

    close(): void {
        this.#socket?.destroy();
        this.#connected = false;
    }

    async #requestConnected(
        method: string,
        target: ControlTarget,
        params?: JsonValue,
        onRelayOutput?: (chunk: string) => void,
        onRequestId?: (requestId: string) => void
    ): Promise<JsonValue> {
        const id = `${this.#requestIdPrefix}-${++this.#counter}`;
        const response = new Promise<JsonValue>((resolve, reject) => {
            this.#pending.set(id, { method, reject, resolve });
        });

        if (onRelayOutput !== undefined) {
            this.#relayOutputs.set(id, onRelayOutput);
        }

        onRequestId?.(id);

        try {
            await this.#writer?.write({
                id,
                method,
                params,
                target,
                type: "request"
            } as unknown as JsonValue);

            return await response;
        } finally {
            this.#relayOutputs.delete(id);
        }
    }

    #accept(frame: JsonValue): void {
        if (!isRecord(frame) || typeof frame.type !== "string") {
            return;
        }

        if (frame.type === "response" && typeof frame.id === "string" && typeof frame.ok === "boolean") {
            const pending = this.#pending.get(frame.id);

            if (pending === undefined) {
                return;
            }

            this.#pending.delete(frame.id);

            if (frame.ok) {
                pending.resolve((frame.result ?? null) as JsonValue);
                return;
            }

            pending.reject(this.#mapRemoteError(frame as unknown as ControlResponseEnvelope));
            return;
        }

        if (frame.type === "relay.output" && typeof frame.id === "string" && typeof frame.data === "string") {
            this.#relayOutputs.get(frame.id)?.(frame.data);
            return;
        }

        if (
            frame.type === "event" &&
            typeof frame.event === "string" &&
            typeof frame.seq === "number" &&
            isRecord(frame.target) &&
            frame.target.kind === "instance" &&
            typeof frame.target.instance === "string"
        ) {
            this.#pushStreamMessage(this.#mapStreamMessage(frame as unknown as ControlEventEnvelope));
        }
    }

    #failPending(error: unknown): void {
        for (const pending of this.#pending.values()) {
            pending.reject(error);
        }

        this.#pending.clear();
        this.#relayOutputs.clear();
    }

    #createConnectionClosedError(): Error {
        const methods = [...new Set([...this.#pending.values()].map((pending) => pending.method))];

        if (this.#socketError === undefined) {
            return new Error(
                methods.length === 0
                    ? "control connection closed"
                    : `control connection closed while waiting for ${methods.join(", ")}`
            );
        }

        return new Error(
            `control connection closed while waiting for ${methods.length === 0 ? "a response" : methods.join(", ")}: ${this.#socketError.message}`,
            {
            cause: this.#socketError
            }
        );
    }

    #pushStreamMessage(message: TStreamMessage): void {
        const waiter = this.#streamWaiters.shift();

        if (waiter !== undefined) {
            waiter.resolve(message);
            return;
        }

        if (message === this.#connectionClosedMessage && this.#streamMessages.at(-1) === this.#connectionClosedMessage) {
            return;
        }

        this.#streamMessages.push(message);
    }

    #resolveDefaultSocketPath(xdgRuntimeDir = process.env.XDG_RUNTIME_DIR): string {
        return resolveControlSocketPath(xdgRuntimeDir);
    }
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
