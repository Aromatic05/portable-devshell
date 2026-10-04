import protobuf from "protobufjs/minimal.js";

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

export function encodeWireEnvelope(envelope: Envelope): Uint8Array {
    const message = encodeEnvelope(
        protobuf.Writer.create(),
        envelope,
    ).finish();
    if (message.byteLength > ENVELOPE_MAX_SIZE)
        throw new Error(`Envelope exceeds ${ENVELOPE_MAX_SIZE} bytes.`);
    return protobuf.Writer.create().bytes(message).finish();
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
    const end = reader.pos + length;
    const value = decodeEnvelope(reader, end);
    return {
        bytesRead: reader.pos,
        envelope: {
            source: decodeAddress(value.source, "source"),
            dest: decodeAddress(value.dest, "dest"),
            packet: decodePacket(value.packet),
        },
    };
}

function encodeEnvelope(
    writer: protobuf.Writer,
    value: Envelope,
): protobuf.Writer {
    encodeAddress(writer.uint32(10).fork(), value.source).ldelim();
    encodeAddress(writer.uint32(18).fork(), value.dest).ldelim();
    encodePacket(writer.uint32(26).fork(), value.packet).ldelim();
    return writer;
}

function encodeAddress(writer: protobuf.Writer, value: Address): protobuf.Writer {
    writer.uint32(10).string(requiredString(value.host, "Envelope address.host"));
    writer.uint32(18).string(requiredString(value.port, "Envelope address.port"));
    return writer;
}

function encodePacket(writer: protobuf.Writer, value: Packet): protobuf.Writer {
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
        const stream = writer.uint32(18).fork();
        stream.uint32(10).string(requiredString(packet.id, "Stream id"));
        stream.uint32(16).uint64(requiredInteger(packet.seq, "Stream seq"));
        stream.uint32(26).bytes(requiredBytes(packet.bytes, "Stream bytes"));
        stream.ldelim();
        return writer;
    }
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Packet is not JSON serializable.");
    writer.uint32(10).bytes(encoder.encode(json));
    return writer;
}

function decodeEnvelope(
    reader: protobuf.Reader,
    end: number,
): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    while (reader.pos < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
            case 1:
                value.source = decodeWireAddress(reader, readEnd(reader));
                break;
            case 2:
                value.dest = decodeWireAddress(reader, readEnd(reader));
                break;
            case 3:
                value.packet = decodePacketMessage(reader, readEnd(reader));
                break;
            default:
                reader.skipType(tag & 7);
        }
    }
    return value;
}

function decodeWireAddress(
    reader: protobuf.Reader,
    end: number,
): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    while (reader.pos < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
            case 1:
                value.host = reader.string();
                break;
            case 2:
                value.port = reader.string();
                break;
            default:
                reader.skipType(tag & 7);
        }
    }
    return value;
}

function decodePacketMessage(
    reader: protobuf.Reader,
    end: number,
): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    while (reader.pos < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
            case 1:
                value.json = reader.bytes();
                value.value = "json";
                break;
            case 2:
                value.streamData = decodeStreamData(reader, readEnd(reader));
                value.value = "streamData";
                break;
            default:
                reader.skipType(tag & 7);
        }
    }
    return value;
}

function decodeStreamData(
    reader: protobuf.Reader,
    end: number,
): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    while (reader.pos < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
            case 1:
                value.id = reader.string();
                break;
            case 2:
                value.seq = uint64Number(reader.uint64());
                break;
            case 3:
                value.data = reader.bytes();
                break;
            default:
                reader.skipType(tag & 7);
        }
    }
    return value;
}

function readEnd(reader: protobuf.Reader): number {
    const length = reader.uint32();
    const end = reader.pos + length;
    if (end > reader.len) throw new RangeError("index out of range");
    return end;
}

function uint64Number(value: number | { toString(): string }): number {
    return typeof value === "number" ? value : Number(value.toString());
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
