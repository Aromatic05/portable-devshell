import type { Channel } from "../endpoint/channel/Channel.js";
import type { Address } from "../endpoint/Address.js";
import type { Packet } from "../packet/Packet.js";

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
        if (chunk.byteLength === 0) return;
        this.#append(chunk);
        while (this.#end - this.#start >= 4) {
            const length = new DataView(
                this.#buffer.buffer,
                this.#buffer.byteOffset + this.#start,
                4,
            ).getUint32(0);
            if (length > ENVELOPE_MAX_SIZE)
                throw new Error(`Envelope exceeds ${ENVELOPE_MAX_SIZE} bytes.`);
            if (this.#end - this.#start < 4 + length) break;
            const payloadStart = this.#start + 4;
            const value = decodeEnvelope(
                JSON.parse(
                    decoder.decode(
                        this.#buffer.subarray(
                            payloadStart,
                            payloadStart + length,
                        ),
                    ),
                ) as unknown,
            );
            for (const listener of this.#listeners) listener(value);
            this.#start += 4 + length;
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

function decodeEnvelope(value: unknown): Envelope {
    if (!isRecord(value)) throw new Error("Envelope must be an object.");
    if (!Object.prototype.hasOwnProperty.call(value, "packet"))
        throw new Error("Envelope packet is required.");
    return {
        source: decodeAddress(value.source, "source"),
        dest: decodeAddress(value.dest, "dest"),
        packet: value.packet,
    };
}

function decodeAddress(value: unknown, name: string): Address {
    if (!isRecord(value)) throw new Error(`Envelope ${name} must be an object.`);
    if (typeof value.host !== "string" || value.host.length === 0)
        throw new Error(`Envelope ${name}.host must be a non-empty string.`);
    if (typeof value.port !== "string" || value.port.length === 0)
        throw new Error(`Envelope ${name}.port must be a non-empty string.`);
    return { host: value.host, port: value.port };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
