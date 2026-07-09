import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import {
    type ControlEventEnvelope,
    type ControlResponseEnvelope,
    type ControlTarget,
    FrameReader,
    FrameWriter,
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
    readonly #reader = new FrameReader();
    readonly #socketFactory: (path: string) => Socket;
    readonly #socketPath: string;
    readonly #pending = new Map<string, { reject: (error: unknown) => void; resolve: (value: JsonValue) => void }>();
    readonly #streamMessages: TuiControlStreamMessage[] = [];
    readonly #streamWaiters: Array<{ resolve: (value: TuiControlStreamMessage) => void }> = [];
    #connected = false;
    #connectionClosed = false;
    #counter = 0;
    #socket?: Socket;
    #writer?: FrameWriter;

    constructor(options: TuiControlConnectionOptions = {}) {
        this.#socketFactory = options.socketFactory ?? createConnection;
        this.#socketPath = options.socketPath ?? resolveDefaultSocketPath(options.xdgRuntimeDir);
    }

    async request(method: string, target: ControlTarget, params?: JsonValue): Promise<JsonValue> {
        await this.connect();
        return await this.#requestConnected(method, target, params);
    }

    async nextStreamMessage(): Promise<TuiControlStreamMessage> {
        const message = this.#streamMessages.shift();

        if (message !== undefined) {
            return message;
        }

        if (this.#connectionClosed) {
            return { kind: "connection.closed" };
        }

        await this.connect();

        return await new Promise<TuiControlStreamMessage>((resolve) => {
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
            this.#pushStreamMessage({ kind: "connection.closed" });
        });
        socket.once("error", (error) => {
            this.#connected = false;
            this.#connectionClosed = true;
            this.#failPending(error);
            this.#pushStreamMessage({ kind: "connection.closed" });
        });

        await this.#requestConnected("control.identifyClient", { kind: "control" }, { clientKind: "tui" });
    }

    close(): void {
        this.#socket?.destroy();
        this.#connected = false;
    }

    async #requestConnected(method: string, target: ControlTarget, params?: JsonValue): Promise<JsonValue> {
        const id = `tui-${++this.#counter}`;
        const response = new Promise<JsonValue>((resolve, reject) => {
            this.#pending.set(id, { reject, resolve });
        });

        await this.#writer?.write({
            id,
            method,
            params,
            target,
            type: "request"
        } as unknown as JsonValue);

        return await response;
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

            pending.reject(toRemoteError(frame as unknown as ControlResponseEnvelope));
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
    }

    #pushStreamMessage(message: TuiControlStreamMessage): void {
        const waiter = this.#streamWaiters.shift();

        if (waiter !== undefined) {
            waiter.resolve(message);
            return;
        }

        if (message.kind === "connection.closed" && this.#streamMessages.at(-1)?.kind === "connection.closed") {
            return;
        }

        this.#streamMessages.push(message);
    }
}

export function createSubscribedStream(
    connection: TuiControlConnection,
    initialEvents: TuiControlEventEnvelope[]
): TuiControlStream {
    return new TuiControlStream(connection, initialEvents);
}

function resolveDefaultSocketPath(xdgRuntimeDir = process.env.XDG_RUNTIME_DIR): string {
    if (xdgRuntimeDir === undefined || xdgRuntimeDir.length === 0) {
        throw new Error("XDG_RUNTIME_DIR is not set.");
    }

    return join(xdgRuntimeDir, "portable-devshell", "control.sock");
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
