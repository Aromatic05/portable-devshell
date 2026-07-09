import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import {
    type ControlEventEnvelope,
    type ControlRelayInputEnvelope,
    type ControlResponseEnvelope,
    type ControlTarget,
    FrameReader,
    FrameWriter,
    type JsonValue
} from "@portable-devshell/shared";

import type {
    CliControlStreamCancelledEnvelope,
    CliControlStreamGapEnvelope
} from "./CliControlRequest.js";
import { CliRenderError } from "../render/CliRenderError.js";
import type { CliControlStreamMessage } from "./CliControlStream.js";

export interface CliControlConnectionOptions {
    clientKind?: "cli" | "tui";
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export class CliControlConnection {
    readonly #clientKind: "cli" | "tui";
    readonly #reader = new FrameReader();
    readonly #socketFactory: (path: string) => Socket;
    readonly #socketPath: string;
    readonly #pending = new Map<string, { reject: (error: unknown) => void; resolve: (value: JsonValue) => void }>();
    readonly #relayOutputs = new Map<string, (chunk: string) => void>();
    readonly #streamMessages: CliControlStreamMessage[] = [];
    readonly #streamWaiters: Array<{ resolve: (value: CliControlStreamMessage) => void }> = [];
    #connected = false;
    #counter = 0;
    #connectionClosed = false;
    #socket?: Socket;
    #writer?: FrameWriter;

    constructor(options: CliControlConnectionOptions = {}) {
        this.#clientKind = options.clientKind ?? "cli";
        this.#socketFactory = options.socketFactory ?? createConnection;
        this.#socketPath = options.socketPath ?? resolveDefaultSocketPath(options.xdgRuntimeDir);
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

    async #requestConnected(
        method: string,
        target: ControlTarget,
        params?: JsonValue,
        onRelayOutput?: (chunk: string) => void,
        onRequestId?: (requestId: string) => void
    ): Promise<JsonValue> {
        const id = `cli-${++this.#counter}`;
        const response = new Promise<JsonValue>((resolve, reject) => {
            this.#pending.set(id, { reject, resolve });
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

    async nextStreamMessage(): Promise<CliControlStreamMessage> {
        const message = this.#streamMessages.shift();

        if (message !== undefined) {
            return message;
        }

        if (this.#connectionClosed) {
            return {
                kind: "connection.closed"
            };
        }

        await this.connect();

        return await new Promise<CliControlStreamMessage>((resolve) => {
            this.#streamWaiters.push({ resolve });
        });
    }

    async connect(): Promise<void> {
        if (this.#connected) {
            return;
        }

        const socket = this.#socketFactory(this.#socketPath);
        this.#socket = socket;
        this.#writer = new FrameWriter(socket);

        await new Promise<void>((resolve, reject) => {
            socket.once("connect", () => {
                this.#connected = true;
                this.#connectionClosed = false;
                resolve();
            });
            socket.once("error", (error) => {
                reject(mapConnectionError(error));
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
            this.#failPending(new Error("control connection closed"));
            this.#pushStreamMessage({
                kind: "connection.closed"
            });
        });
        socket.once("error", (error) => {
            this.#connected = false;
            this.#connectionClosed = true;
            this.#failPending(error);
            this.#pushStreamMessage({
                kind: "connection.closed"
            });
        });

        await this.#requestConnected("control.identifyClient", { kind: "control" }, { clientKind: this.#clientKind });
    }

    close(): void {
        this.#socket?.destroy();
        this.#connected = false;
    }

    #accept(frame: JsonValue): void {
        if (!isRecord(frame) || typeof frame.type !== "string") {
            return;
        }

        if (frame.type === "response" && typeof frame.id === "string" && typeof frame.ok === "boolean") {
            const resolve = this.#pending.get(frame.id);

            if (resolve === undefined) {
                return;
            }

            this.#pending.delete(frame.id);

            if (frame.ok) {
                resolve.resolve((frame.result ?? null) as JsonValue);
                return;
            }

            resolve.reject(toRemoteError(frame as unknown as ControlResponseEnvelope));
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
            const event = frame as unknown as ControlEventEnvelope;
            this.#pushStreamMessage(toStreamMessage(event));
        }
    }

    #failPending(error: unknown): void {
        for (const pending of this.#pending.values()) {
            pending.reject(error);
        }

        this.#pending.clear();

        this.#relayOutputs.clear();
    }

    #pushStreamMessage(message: CliControlStreamMessage): void {
        if (message.kind === "connection.closed" && this.#connectionClosed !== true) {
            this.#connectionClosed = true;
        }

        const waiter = this.#streamWaiters.shift();

        if (waiter !== undefined) {
            waiter.resolve(message);
            return;
        }

        if (message.kind === "connection.closed") {
            const lastMessage = this.#streamMessages.at(-1);

            if (lastMessage?.kind === "connection.closed") {
                return;
            }
        }

        this.#streamMessages.push(message);
    }
}

function resolveDefaultSocketPath(xdgRuntimeDir = process.env.XDG_RUNTIME_DIR): string {
    if (xdgRuntimeDir === undefined || xdgRuntimeDir.length === 0) {
        throw new CliRenderError("control.notRunning", "XDG_RUNTIME_DIR is not set.");
    }

    return join(xdgRuntimeDir, "portable-devshell", "control.sock");
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
