import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";

import type {
    CliControlEventEnvelope,
    CliControlResponseEnvelope,
    CliControlTarget
} from "./CliControlRequest.js";
import { CliRenderError } from "../render/CliRenderError.js";

export interface CliControlConnectionOptions {
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export class CliControlConnection {
    readonly #reader = new FrameReader();
    readonly #socketFactory: (path: string) => Socket;
    readonly #socketPath: string;
    readonly #pending = new Map<string, { reject: (error: unknown) => void; resolve: (value: JsonValue) => void }>();
    readonly #relayOutputs = new Map<string, (chunk: string) => void>();
    readonly #events: CliControlEventEnvelope[] = [];
    readonly #eventWaiters: Array<{ reject: (error: unknown) => void; resolve: (value: CliControlEventEnvelope) => void }> = [];
    #connected = false;
    #counter = 0;
    #socket?: Socket;
    #writer?: FrameWriter;

    constructor(options: CliControlConnectionOptions = {}) {
        this.#socketFactory = options.socketFactory ?? createConnection;
        this.#socketPath = options.socketPath ?? resolveDefaultSocketPath(options.xdgRuntimeDir);
    }

    async request(method: string, target: CliControlTarget, params?: JsonValue): Promise<JsonValue> {
        return await this.#request(method, target, params);
    }

    async requestWithRelay(
        method: string,
        target: CliControlTarget,
        relay: { onOutput(chunk: string): void; onRequestId?(requestId: string): void },
        params?: JsonValue
    ): Promise<JsonValue> {
        return await this.#request(method, target, params, relay.onOutput, relay.onRequestId);
    }

    async sendRelayInput(requestId: string, chunk: Uint8Array): Promise<void> {
        await this.connect();
        await this.#writer?.write({
            data: Buffer.from(chunk).toString("base64"),
            id: requestId,
            type: "relay.input"
        } as unknown as JsonValue);
    }

    async sendRelayEof(requestId: string): Promise<void> {
        await this.connect();
        await this.#writer?.write({
            eof: true,
            id: requestId,
            type: "relay.input"
        } as unknown as JsonValue);
    }

    async #request(
        method: string,
        target: CliControlTarget,
        params?: JsonValue,
        onRelayOutput?: (chunk: string) => void,
        onRequestId?: (requestId: string) => void
    ): Promise<JsonValue> {
        await this.connect();
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
                issuedAt: new Date().toISOString(),
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

    async nextEvent(): Promise<CliControlEventEnvelope> {
        await this.connect();
        const event = this.#events.shift();

        if (event !== undefined) {
            return event;
        }

        return await new Promise<CliControlEventEnvelope>((resolve, reject) => {
            this.#eventWaiters.push({ reject, resolve });
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
            this.#failPending(new Error("control connection closed"));
        });
        socket.once("error", (error) => {
            this.#failPending(error);
        });
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

            resolve.reject(toRemoteError(frame as unknown as CliControlResponseEnvelope));
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
            const event = frame as unknown as CliControlEventEnvelope;
            const waiter = this.#eventWaiters.shift();

            if (waiter !== undefined) {
                waiter.resolve(event);
                return;
            }

            this.#events.push(event);
        }
    }

    #failPending(error: unknown): void {
        for (const pending of this.#pending.values()) {
            pending.reject(error);
        }

        this.#pending.clear();

        for (const waiter of this.#eventWaiters.splice(0)) {
            waiter.reject(error);
        }

        this.#relayOutputs.clear();
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

function toRemoteError(response: CliControlResponseEnvelope): CliRenderError {
    return new CliRenderError(response.error?.code ?? "control.requestFailed", response.error?.message ?? "control request failed", {
        cause: response.error?.cause,
        details: response.error?.details,
        retryable: response.error?.retryable
    });
}
