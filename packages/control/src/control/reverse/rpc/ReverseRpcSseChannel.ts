import type { ServerResponse } from "node:http";

import { WorkerRpcChannelBase } from "@portable-devshell/core";
import type { JsonValue } from "@portable-devshell/shared";

import { ReverseRpcFrameCodec } from "./ReverseRpcFrameCodec.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

export class ReverseRpcSseChannel extends WorkerRpcChannelBase {
    readonly #response: ServerResponse;
    readonly #heartbeat: NodeJS.Timeout;
    #acceptedUpstreamSeq = 0;
    #downstreamSeq: number;

    constructor(response: ServerResponse, lastDownstreamAck = 0) {
        super();
        this.#response = response;
        this.#downstreamSeq = lastDownstreamAck;
        response.once("close", () => this.#disconnect(new Error("reverse SSE connection closed")));
        response.once("error", (error) => this.#disconnect(error));
        this.#heartbeat = setInterval(() => {
            if (!this.disconnected) {
                response.write(`: ping ${Date.now()}\n\n`);
            }
        }, HEARTBEAT_INTERVAL_MS);
        this.#heartbeat.unref();
    }

    get acceptedUpstreamSeq(): number {
        return this.#acceptedUpstreamSeq;
    }

    async send(message: JsonValue): Promise<void> {
        if (this.disconnected || this.#response.writableEnded) {
            throw new Error("reverse SSE channel is disconnected");
        }
        this.#downstreamSeq += 1;
        const frame = ReverseRpcFrameCodec.encode(message).toString("base64");
        const written = this.#response.write(`id: ${this.#downstreamSeq}\nevent: frame\ndata: ${frame}\n\n`);
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
            throw new Error(`upstream sequence gap: expected ${this.#acceptedUpstreamSeq + 1}, received ${seq}`);
        }
        this.#acceptedUpstreamSeq = seq;
        this.emitMessage(ReverseRpcFrameCodec.decode(Buffer.from(encodedFrame, "base64")));
        return this.#acceptedUpstreamSeq;
    }

    close(): void {
        if (!this.#response.writableEnded) {
            this.#response.end();
        }
        this.#disconnect(new Error("reverse SSE channel closed"));
    }

    #disconnect(error: unknown): void {
        this.notifyDisconnect(error, () => clearInterval(this.#heartbeat));
    }
}
