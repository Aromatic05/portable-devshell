import type { ServerResponse } from "node:http";

import { ChannelBase } from "@portable-devshell/shared";
import { decodeFrame, encodeFrame, type Frame } from "@portable-devshell/shared/transport/frame";

const HEARTBEAT_INTERVAL_MS = 15_000;

export interface ReverseRpcSseChannelOptions {
    heartbeatIntervalMs?: number;
    now?: () => number;
}

export class ReverseRpcSseChannel extends ChannelBase {
    readonly #response: ServerResponse;
    readonly #heartbeat: NodeJS.Timeout;
    readonly #now: () => number;
    #acceptedUpstreamSeq = 0;
    #downstreamSeq: number;

    constructor(response: ServerResponse, lastDownstreamAck = 0, options: ReverseRpcSseChannelOptions = {}) {
        super();
        this.#response = response;
        this.#now = options.now ?? Date.now;
        this.#downstreamSeq = lastDownstreamAck;
        response.once("close", () => this.#disconnect(new Error("reverse SSE connection closed")));
        response.once("error", (error) => this.#disconnect(error));
        this.#heartbeat = setInterval(() => {
            if (!this.closed) {
                try { response.write(`: ping ${this.#now()}\n\n`); }
                catch (error) { this.#disconnect(error); }
            }
        }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
        this.#heartbeat.unref();
    }

    get acceptedUpstreamSeq(): number { return this.#acceptedUpstreamSeq; }

    async send(frame: Frame): Promise<void> {
        if (this.closed || this.#response.writableEnded) throw new Error("reverse SSE channel is disconnected");
        const nextSeq = this.#downstreamSeq + 1;
        try {
            const written = this.#response.write(`id: ${nextSeq}\nevent: frame\ndata: ${encodeFrame(frame).toString("base64")}\n\n`);
            this.#downstreamSeq = nextSeq;
            if (!written) await this.#waitForDrain();
        } catch (error) {
            this.#disconnect(error);
            throw error instanceof Error ? error : new Error(String(error));
        }
    }

    acceptUpstream(seq: number, encodedFrame: string): number {
        if (this.closed) throw new Error("reverse SSE channel is disconnected");
        if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error("upstream sequence must be a positive integer");
        if (seq <= this.#acceptedUpstreamSeq) return this.#acceptedUpstreamSeq;
        if (seq !== this.#acceptedUpstreamSeq + 1) {
            throw new Error(`upstream sequence gap: expected ${this.#acceptedUpstreamSeq + 1}, received ${seq}`);
        }
        this.emitFrame(decodeFrame(Buffer.from(encodedFrame, "base64")));
        this.#acceptedUpstreamSeq = seq;
        return seq;
    }

    close(error?: Error): void {
        if (this.closed) return;
        try { if (!this.#response.writableEnded) this.#response.end(); }
        catch (closeError) { this.#disconnect(closeError); return; }
        clearInterval(this.#heartbeat);
        this.finish(error);
    }

    async #waitForDrain(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                this.#response.off("close", onClose);
                this.#response.off("drain", onDrain);
                this.#response.off("error", onError);
            };
            const onClose = () => { cleanup(); reject(new Error("reverse SSE connection closed before drain")); };
            const onDrain = () => { cleanup(); resolve(); };
            const onError = (error: Error) => { cleanup(); reject(error); };
            this.#response.once("close", onClose);
            this.#response.once("drain", onDrain);
            this.#response.once("error", onError);
        });
    }

    #disconnect(error: unknown): void {
        clearInterval(this.#heartbeat);
        this.finish(error instanceof Error ? error : new Error(String(error)));
    }
}
