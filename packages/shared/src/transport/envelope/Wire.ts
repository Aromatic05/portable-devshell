import protobuf from "protobufjs/light.js";

import type { Address } from "../endpoint/Address.js";
import type { Packet } from "../packet/Packet.js";
import { envelopeSchema } from "./Schema.js";

export interface Envelope {
    readonly source: Address;
    readonly dest: Address;
    readonly packet: Packet;
}

export const ENVELOPE_MAX_SIZE = 16 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const root = protobuf.Root.fromJSON(
    envelopeSchema as unknown as protobuf.INamespace,
);
const envelopeType = root.lookupType("devshell.transport.Envelope");

export function encodeWireEnvelope(envelope: Envelope): Uint8Array {
    const encoded = envelopeType
        .encodeDelimited(
            envelopeType.create({
                source: envelope.source,
                dest: envelope.dest,
                packet: encodePacket(envelope.packet),
            }),
        )
        .finish();
    const reader = protobuf.Reader.create(encoded);
    const length = reader.uint32();
    if (length > ENVELOPE_MAX_SIZE)
        throw new Error(`Envelope exceeds ${ENVELOPE_MAX_SIZE} bytes.`);
    return encoded;
}

export function decodeWireEnvelope(
    data: Uint8Array,
): { readonly bytesRead: number; readonly envelope: Envelope } | undefined {
    const reader = protobuf.Reader.create(data);
    let length: number;
    try {
        length = reader.uint32();
    } catch (error) {
        if (error instanceof RangeError) return undefined;
        throw error;
    }
    if (length > ENVELOPE_MAX_SIZE)
        throw new Error(`Envelope exceeds ${ENVELOPE_MAX_SIZE} bytes.`);
    if (reader.len - reader.pos < length) return undefined;
    const message = envelopeType.decode(reader, length);
    const value = asRecord(
        envelopeType.toObject(message, {
            defaults: false,
            longs: Number,
            oneofs: true,
        }),
        "Envelope",
    );
    return {
        bytesRead: reader.pos,
        envelope: {
            source: decodeAddress(value.source, "source"),
            dest: decodeAddress(value.dest, "dest"),
            packet: decodePacket(value.packet),
        },
    };
}

function encodePacket(value: Packet): Record<string, unknown> {
    const packet = asRecord(value, "Packet");
    if (
        packet.protocol === "stream" &&
        packet.type === "data" &&
        packet.bytes !== undefined
    ) {
        if (packet.message !== undefined)
            throw new Error(
                "Stream DATA cannot contain both bytes and message.",
            );
        return {
            streamData: {
                id: requiredString(packet.id, "Stream id"),
                seq: requiredInteger(packet.seq, "Stream seq"),
                data: requiredBytes(packet.bytes, "Stream bytes"),
            },
        };
    }
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Packet is not JSON serializable.");
    return { json: encoder.encode(json) };
}

function decodePacket(value: unknown): Packet {
    const packet = asRecord(value, "Packet");
    if (packet.value === "streamData") {
        const data = asRecord(packet.streamData, "Stream DATA");
        return {
            protocol: "stream",
            type: "data",
            id: requiredString(data.id, "Stream id"),
            seq: requiredInteger(data.seq, "Stream seq"),
            bytes: Uint8Array.from(requiredBytes(data.data, "Stream bytes")),
        };
    }
    if (packet.value === "json") {
        const data = requiredBytes(packet.json, "Packet JSON");
        return JSON.parse(decoder.decode(data)) as Packet;
    }
    throw new Error("Packet value is missing.");
}

function decodeAddress(value: unknown, name: string): Address {
    const address = asRecord(value, `Envelope ${name}`);
    return {
        host: requiredString(address.host, `Envelope ${name}.host`),
        port: requiredString(address.port, `Envelope ${name}.port`),
    };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${name} must be an object.`);
    return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0)
        throw new Error(`${name} must be a non-empty string.`);
    return value;
}

function requiredInteger(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new Error(`${name} must be a non-negative safe integer.`);
    return value;
}

function requiredBytes(value: unknown, name: string): Uint8Array {
    if (!(value instanceof Uint8Array))
        throw new Error(`${name} must be bytes.`);
    return value;
}
