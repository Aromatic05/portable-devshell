import type { Channel } from "../endpoint/channel/Channel.js";
import {
    decodeWireEnvelope,
    encodeWireEnvelope,
    type Envelope,
} from "./Wire.js";

export { ENVELOPE_MAX_SIZE, type Envelope } from "./Wire.js";

export class EnvelopeCodec {
    readonly #channel: Channel;
    readonly #listeners = new Set<(envelope: Envelope) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    #buffer = new Uint8Array(1024);
    #end = 0;
    #start = 0;

    constructor(channel: Channel) {
        this.#channel = channel;
        channel.onData((data) => {
            try {
                this.#accept(data);
            } catch (error) {
                this.close(asError(error));
            }
        });
        channel.onClose((error) => {
            for (const listener of this.#closeListeners) listener(error);
        });
    }

    async send(envelope: Envelope): Promise<void> {
        await this.#channel.write(encodeWireEnvelope(envelope));
    }

    onEnvelope(listener: (envelope: Envelope) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        this.#channel.close(error);
    }

    #accept(chunk: Uint8Array): void {
        if (chunk.byteLength === 0) return;
        this.#append(chunk);
        while (this.#start < this.#end) {
            const decoded = decodeWireEnvelope(
                this.#buffer.subarray(this.#start, this.#end),
            );
            if (decoded === undefined) break;
            for (const listener of this.#listeners) listener(decoded.envelope);
            this.#start += decoded.bytesRead;
        }
        if (this.#start === this.#end) {
            this.#start = 0;
            this.#end = 0;
        }
    }

    #append(chunk: Uint8Array): void {
        const unread = this.#end - this.#start;
        const required = unread + chunk.byteLength;
        if (this.#buffer.byteLength < required) {
            let capacity = this.#buffer.byteLength;
            while (capacity < required) capacity *= 2;
            const next = new Uint8Array(capacity);
            if (unread > 0)
                next.set(this.#buffer.subarray(this.#start, this.#end), 0);
            this.#buffer = next;
            this.#start = 0;
            this.#end = unread;
        } else if (this.#end + chunk.byteLength > this.#buffer.byteLength) {
            this.#buffer.copyWithin(0, this.#start, this.#end);
            this.#start = 0;
            this.#end = unread;
        }
        this.#buffer.set(chunk, this.#end);
        this.#end += chunk.byteLength;
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
