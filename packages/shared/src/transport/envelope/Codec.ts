import type { Channel } from "../endpoint/channel/Channel.js";

export type Host = string;
export type PortName = string;
export type Packet = unknown;

export interface Address {
    readonly host: Host;
    readonly port: PortName;
}

export interface Envelope {
    readonly source: Address;
    readonly dest: Address;
    readonly packet: Packet;
}

export const ENVELOPE_MAX_SIZE = 16 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export class EnvelopeCodec {
    readonly #channel: Channel;
    readonly #listeners = new Set<(envelope: Envelope) => void>();
    readonly #closeListeners = new Set<(error?: Error) => void>();
    #buffer = new Uint8Array();

    constructor(channel: Channel) {
        this.#channel = channel;
        channel.onData((data) => this.#accept(data));
        channel.onClose((error) => {
            for (const listener of this.#closeListeners) listener(error);
        });
    }

    async send(envelope: Envelope): Promise<void> {
        const payload = encoder.encode(JSON.stringify(envelope));
        if (payload.byteLength > ENVELOPE_MAX_SIZE)
            throw new Error(`Envelope exceeds ${ENVELOPE_MAX_SIZE} bytes.`);
        const data = new Uint8Array(4 + payload.byteLength);
        new DataView(data.buffer).setUint32(0, payload.byteLength);
        data.set(payload, 4);
        await this.#channel.write(data);
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
        const data = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
        data.set(this.#buffer);
        data.set(chunk, this.#buffer.byteLength);
        let offset = 0;
        while (data.byteLength - offset >= 4) {
            const length = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0);
            if (length > ENVELOPE_MAX_SIZE)
                throw new Error(`Envelope exceeds ${ENVELOPE_MAX_SIZE} bytes.`);
            if (data.byteLength - offset < 4 + length) break;
            const value = JSON.parse(
                decoder.decode(data.subarray(offset + 4, offset + 4 + length)),
            ) as Envelope;
            for (const listener of this.#listeners) listener(value);
            offset += 4 + length;
        }
        this.#buffer = data.slice(offset);
    }
}
