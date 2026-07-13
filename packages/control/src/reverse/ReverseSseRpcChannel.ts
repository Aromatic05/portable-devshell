import type { ServerResponse } from "node:http";

import type { WorkerRpcChannel } from "@portable-devshell/core";
import { FrameCodec, type JsonValue } from "@portable-devshell/shared";

const HEARTBEAT_INTERVAL_MS = 15_000;

export class ReverseSseRpcChannel implements WorkerRpcChannel {
    readonly #response: ServerResponse;
    readonly #messageListeners = new Set<(message: JsonValue) => void>();
    readonly #disconnectListeners = new Set<(error: unknown) => void>();
    readonly #heartbeat: NodeJS.Timeout;
    #acceptedUpstreamSeq = 0;
    #downstreamSeq: number;
    #disconnected = false;

    constructor(response: ServerResponse, lastDownstreamAck = 0) {
        this.#response = response;
        this.#downstreamSeq = lastDownstreamAck;
        response.once("close", () => this.#disconnect(new Error("reverse SSE connection closed")));
        response.once("error", (error) => this.#disconnect(error));
        this.#heartbeat = setInterval(() => {
            if (!this.#disconnected) {
                response.write(`: ping ${Date.now()}\n\n`);
            }
        }, HEARTBEAT_INTERVAL_MS);
        this.#heartbeat.unref();
    }

    get acceptedUpstreamSeq(): number {
        return this.#acceptedUpstreamSeq;
    }

    async send(message: JsonValue): Promise<void> {
        if (this.#disconnected || this.#response.writableEnded) {
            throw new Error("reverse SSE channel is disconnected");
        }
        this.#downstreamSeq += 1;
        const frame = FrameCodec.encode(message).toString("base64");
        const written = this.#response.write(
            `id: ${this.#downstreamSeq}\nevent: frame\ndata: ${frame}\n\n`
        );
        if (!written) {
            await new Promise<void>((resolve, reject) => {
                this.#response.once("drain", resolve);
                this.#response.once("error", reject);
            });
        }
    }

    acceptUpstream(seq: number, encodedFrame: string): number {
        if (!Number.isSafeInteger(seq) || seq <= 0) {
            throw new Error("upstream sequence must be a positive integer");
        }
        if (seq <= this.#acceptedUpstreamSeq) {
            return this.#acceptedUpstreamSeq;
        }
        if (seq !== this.#acceptedUpstreamSeq + 1) {
            throw new Error(
                `upstream sequence gap: expected ${this.#acceptedUpstreamSeq + 1}, received ${seq}`
            );
        }
        const frame = Buffer.from(encodedFrame, "base64");
        const message = FrameCodec.decode(frame);
        this.#acceptedUpstreamSeq = seq;
        for (const listener of this.#messageListeners) {
            listener(message);
        }
        return this.#acceptedUpstreamSeq;
    }

    onMessage(listener: (message: JsonValue) => void): () => void {
        this.#messageListeners.add(listener);
        return () => this.#messageListeners.delete(listener);
    }

    onDisconnect(listener: (error: unknown) => void): () => void {
        this.#disconnectListeners.add(listener);
        return () => this.#disconnectListeners.delete(listener);
    }

    close(): void {
        if (!this.#response.writableEnded) {
            this.#response.end();
        }
        this.#disconnect(new Error("reverse SSE channel closed"));
    }

    #disconnect(error: unknown): void {
        if (this.#disconnected) {
            return;
        }
        this.#disconnected = true;
        clearInterval(this.#heartbeat);
        for (const listener of this.#disconnectListeners) {
            listener(error);
        }
    }
}
