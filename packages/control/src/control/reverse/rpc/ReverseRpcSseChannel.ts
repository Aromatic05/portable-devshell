import type { ServerResponse } from "node:http";

import { WorkerRpcChannelBase } from "@portable-devshell/core";
import type { JsonValue } from "@portable-devshell/shared";

import { ReverseRpcFrameCodec } from "./ReverseRpcFrameCodec.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

export interface ReverseRpcSseChannelOptions {
    heartbeatIntervalMs?: number;
    now?: () => number;
}

export class ReverseRpcSseChannel extends WorkerRpcChannelBase {
    readonly #response: ServerResponse;
    readonly #heartbeat: NodeJS.Timeout;
    readonly #now: () => number;
    #acceptedUpstreamSeq = 0;
    #downstreamSeq: number;

    constructor(
        response: ServerResponse,
        lastDownstreamAck = 0,
        options: ReverseRpcSseChannelOptions = {}
    ) {
        super();
        this.#response = response;
        this.#now = options.now ?? Date.now;
        this.#downstreamSeq = lastDownstreamAck;
        response.once("close", () => this.#disconnect(new Error("reverse SSE connection closed")));
        response.once("error", (error) => this.#disconnect(error));
        this.#heartbeat = setInterval(() => {
            if (!this.disconnected) {
                try {
                    response.write(`: ping ${this.#now()}\n\n`);
                } catch (error) {
                    this.#disconnect(error);
                }
            }
        }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
        this.#heartbeat.unref();
    }

    get acceptedUpstreamSeq(): number {
        return this.#acceptedUpstreamSeq;
    }

    async send(message: JsonValue): Promise<void> {
        if (this.disconnected || this.#response.writableEnded) {
            throw new Error("reverse SSE channel is disconnected");
        }
        const nextSeq = this.#downstreamSeq + 1;
        const frame = ReverseRpcFrameCodec.encode(message).toString("base64");
        try {
            const written = this.#response.write(`id: ${nextSeq}\nevent: frame\ndata: ${frame}\n\n`);
            this.#downstreamSeq = nextSeq;
            if (!written) {
                await this.#waitForDrain();
            }
        } catch (error) {
            this.#disconnect(error);
            throw error instanceof Error ? error : new Error(String(error));
        }
    }

    acceptUpstream(seq: number, encodedFrame: string): number {
        if (this.disconnected) {
            throw new Error("reverse SSE channel is disconnected");
        }
        if (!Number.isSafeInteger(seq) || seq <= 0) {
            throw new Error("upstream sequence must be a positive integer");
        }
        if (seq <= this.#acceptedUpstreamSeq) {
            return this.#acceptedUpstreamSeq;
        }
        if (seq !== this.#acceptedUpstreamSeq + 1) {
            throw new Error(`upstream sequence gap: expected ${this.#acceptedUpstreamSeq + 1}, received ${seq}`);
        }
        const message = ReverseRpcFrameCodec.decode(Buffer.from(encodedFrame, "base64"));
        this.#acceptedUpstreamSeq = seq;
        this.emitMessage(message);
        return this.#acceptedUpstreamSeq;
    }

    close(): void {
        try {
            if (!this.#response.writableEnded) {
                this.#response.end();
            }
        } catch (error) {
            this.#disconnect(error);
            return;
        }
        this.#disconnect(new Error("reverse SSE channel closed"));
    }

    async #waitForDrain(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                this.#response.off("close", onClose);
                this.#response.off("drain", onDrain);
                this.#response.off("error", onError);
            };
            const onClose = () => {
                cleanup();
                reject(new Error("reverse SSE connection closed before drain"));
            };
            const onDrain = () => {
                cleanup();
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            this.#response.once("close", onClose);
            this.#response.once("drain", onDrain);
            this.#response.once("error", onError);
        });
    }

    #disconnect(error: unknown): void {
        this.notifyDisconnect(error, () => clearInterval(this.#heartbeat));
    }
}
