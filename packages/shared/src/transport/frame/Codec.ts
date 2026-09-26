import type { ErrorCode } from "../../protocol/Error.js";
import { createError } from "../../protocol/Error.js";

const PACKET_HEADER_SIZE = 4;
const FRAME_HEADER_SIZE = 6;
const OPEN_FIXED_SIZE = 6;
const WINDOW_PAYLOAD_SIZE = 4;
const RESET_CODE_SIZE = 2;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export const FRAME_PROTOCOL_VERSION = 1;
export const FRAME_MAX_DATA_SIZE = 64 * 1024;
export const FRAME_MAX_OPEN_METADATA_SIZE = 64 * 1024;
export const FRAME_MAX_OPEN_SERVICE_SIZE = 256;
export const TRANSPORT_MAX_FRAME_SIZE = 16 * 1024 * 1024;

export const frameResetCodes = {
    unsupportedService: 1,
    serviceRejected: 2,
    serviceFailed: 3,
    cancelled: 4,
    streamProtocolError: 5,
} as const;

export type FrameResetCode =
    (typeof frameResetCodes)[keyof typeof frameResetCodes];

export type Frame =
    | {
          readonly type: "open";
          readonly streamId: number;
          readonly receiveWindow: number;
          readonly service: string;
          readonly metadata: Uint8Array;
      }
    | {
          readonly type: "data";
          readonly streamId: number;
          readonly data: Uint8Array;
      }
    | {
          readonly type: "window";
          readonly streamId: number;
          readonly creditDelta: number;
      }
    | { readonly type: "fin"; readonly streamId: number }
    | {
          readonly type: "reset";
          readonly streamId: number;
          readonly code: number;
          readonly message: string;
      };

enum FrameType {
    Open = 0x01,
    Data = 0x02,
    Window = 0x03,
    Fin = 0x04,
    Reset = 0x05,
}

/**
 * @compat packet-buffer-pre-frame-v1
 * @removeAt 0.7.10
 * Generic length-prefixed packet decoder retained for protocols that have not
 * migrated to Frame v1 yet. The packet body has no Frame semantics.
 */
export class PacketBuffer {
    readonly #maxPacketSize: number;
    #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
    #end = 0;
    #start = 0;

    constructor(maxPacketSize = TRANSPORT_MAX_FRAME_SIZE) {
        this.#maxPacketSize = maxPacketSize;
    }

    get empty(): boolean {
        return this.#start === this.#end;
    }

    push(chunk: Uint8Array): Uint8Array[] {
        if (chunk.byteLength === 0) return [];
        this.#append(chunk);
        const packets: Uint8Array[] = [];
        while (this.#end - this.#start >= PACKET_HEADER_SIZE) {
            const payloadLength = readU32(this.#buffer, this.#start);
            assertPacketSize(payloadLength, this.#maxPacketSize);
            const packetLength = PACKET_HEADER_SIZE + payloadLength;
            if (this.#end - this.#start < packetLength) break;
            const payloadStart = this.#start + PACKET_HEADER_SIZE;
            packets.push(
                this.#buffer.slice(payloadStart, this.#start + packetLength),
            );
            this.#start += packetLength;
        }
        if (this.#start === this.#end) {
            this.#buffer = new Uint8Array();
            this.#start = 0;
            this.#end = 0;
        }
        return packets;
    }

    reset(): void {
        this.#buffer = new Uint8Array();
        this.#start = 0;
        this.#end = 0;
    }

    #append(chunk: Uint8Array): void {
        const unread = this.#end - this.#start;
        const required = unread + chunk.byteLength;
        if (this.#buffer.byteLength < required) {
            let capacity = Math.max(1024, this.#buffer.byteLength);
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

export function encodePacket(
    payload: Uint8Array,
    maxPacketSize = TRANSPORT_MAX_FRAME_SIZE,
): Uint8Array {
    assertPacketSize(payload.byteLength, maxPacketSize);
    const packet = new Uint8Array(PACKET_HEADER_SIZE + payload.byteLength);
    writeU32(packet, 0, payload.byteLength);
    packet.set(payload, PACKET_HEADER_SIZE);
    return packet;
}

export function decodePacket(
    packet: Uint8Array,
    maxPacketSize = TRANSPORT_MAX_FRAME_SIZE,
): Uint8Array {
    if (packet.byteLength < PACKET_HEADER_SIZE) {
        throw protocolError("Packet header is incomplete.");
    }
    const payloadLength = readU32(packet, 0);
    assertPacketSize(payloadLength, maxPacketSize);
    if (packet.byteLength !== PACKET_HEADER_SIZE + payloadLength) {
        throw protocolError("Packet length does not match payload length.");
    }
    return packet.slice(PACKET_HEADER_SIZE);
}

export class FrameBuffer {
    readonly #packets: PacketBuffer;

    constructor(maxFrameSize = TRANSPORT_MAX_FRAME_SIZE) {
        this.#packets = new PacketBuffer(maxFrameSize);
    }

    get empty(): boolean {
        return this.#packets.empty;
    }

    push(chunk: Uint8Array): Frame[] {
        return this.#packets.push(chunk).map(decodeFramePayload);
    }

    reset(): void {
        this.#packets.reset();
    }
}

export function encodeFrame(frame: Frame): Uint8Array {
    assertStreamId(frame.streamId);
    let payload: Uint8Array;
    switch (frame.type) {
        case "open":
            payload = encodeOpen(frame);
            break;
        case "data":
            if (frame.data.byteLength > FRAME_MAX_DATA_SIZE) {
                throw protocolError(
                    `DATA payload exceeds ${FRAME_MAX_DATA_SIZE} bytes.`,
                    "protocol.frameTooLarge",
                );
            }
            payload = frame.data;
            break;
        case "window":
            assertPositiveU32(frame.creditDelta, "WINDOW credit");
            payload = new Uint8Array(WINDOW_PAYLOAD_SIZE);
            writeU32(payload, 0, frame.creditDelta);
            break;
        case "fin":
            payload = new Uint8Array();
            break;
        case "reset": {
            assertU16(frame.code, "RESET code");
            const message = encoder.encode(frame.message);
            payload = new Uint8Array(RESET_CODE_SIZE + message.byteLength);
            writeU16(payload, 0, frame.code);
            payload.set(message, RESET_CODE_SIZE);
            break;
        }
    }

    const body = new Uint8Array(FRAME_HEADER_SIZE + payload.byteLength);
    body[0] = FRAME_PROTOCOL_VERSION;
    body[1] = typeCode(frame.type);
    writeU32(body, 2, frame.streamId);
    body.set(payload, FRAME_HEADER_SIZE);
    return encodePacket(body);
}

export function decodeFrame(packet: Uint8Array): Frame {
    return decodeFramePayload(decodePacket(packet));
}

function encodeOpen(frame: Extract<Frame, { type: "open" }>): Uint8Array {
    assertPositiveU32(frame.receiveWindow, "OPEN receive window");
    const service = encoder.encode(frame.service);
    if (
        service.byteLength === 0 ||
        service.byteLength > UINT16_MAX ||
        service.byteLength > FRAME_MAX_OPEN_SERVICE_SIZE
    ) {
        throw protocolError("OPEN service must be a non-empty UTF-8 name.");
    }
    if (frame.metadata.byteLength > FRAME_MAX_OPEN_METADATA_SIZE) {
        throw protocolError(
            `OPEN metadata exceeds ${FRAME_MAX_OPEN_METADATA_SIZE} bytes.`,
            "protocol.frameTooLarge",
        );
    }
    const payload = new Uint8Array(
        OPEN_FIXED_SIZE + service.byteLength + frame.metadata.byteLength,
    );
    writeU32(payload, 0, frame.receiveWindow);
    writeU16(payload, 4, service.byteLength);
    payload.set(service, OPEN_FIXED_SIZE);
    payload.set(frame.metadata, OPEN_FIXED_SIZE + service.byteLength);
    return payload;
}

function decodeFramePayload(body: Uint8Array): Frame {
    if (body.byteLength < FRAME_HEADER_SIZE) {
        throw protocolError("Frame header is incomplete.");
    }
    const version = body[0];
    if (version !== FRAME_PROTOCOL_VERSION) {
        throw protocolError(`Unsupported Frame protocol version ${version}.`);
    }
    const type = body[1];
    const streamId = readU32(body, 2);
    assertStreamId(streamId);
    const payload = body.subarray(FRAME_HEADER_SIZE);

    switch (type) {
        case FrameType.Open:
            return decodeOpen(streamId, payload);
        case FrameType.Data:
            if (payload.byteLength > FRAME_MAX_DATA_SIZE) {
                throw protocolError(
                    `DATA payload exceeds ${FRAME_MAX_DATA_SIZE} bytes.`,
                    "protocol.frameTooLarge",
                );
            }
            return { type: "data", streamId, data: Uint8Array.from(payload) };
        case FrameType.Window: {
            if (payload.byteLength !== WINDOW_PAYLOAD_SIZE) {
                throw protocolError("WINDOW payload must be exactly 4 bytes.");
            }
            const creditDelta = readU32(payload, 0);
            assertPositiveU32(creditDelta, "WINDOW credit");
            return { type: "window", streamId, creditDelta };
        }
        case FrameType.Fin:
            if (payload.byteLength !== 0) {
                throw protocolError("FIN payload must be empty.");
            }
            return { type: "fin", streamId };
        case FrameType.Reset: {
            if (payload.byteLength < RESET_CODE_SIZE) {
                throw protocolError("RESET payload is incomplete.");
            }
            const code = readU16(payload, 0);
            assertU16(code, "RESET code");
            return {
                type: "reset",
                streamId,
                code,
                message: decodeUtf8(
                    payload.subarray(RESET_CODE_SIZE),
                    "RESET message",
                ),
            };
        }
        default:
            throw protocolError(`Unknown Frame type ${String(type)}.`);
    }
}

function decodeOpen(streamId: number, payload: Uint8Array): Frame {
    if (payload.byteLength < OPEN_FIXED_SIZE) {
        throw protocolError("OPEN payload is incomplete.");
    }
    const receiveWindow = readU32(payload, 0);
    assertPositiveU32(receiveWindow, "OPEN receive window");
    const serviceLength = readU16(payload, 4);
    if (serviceLength === 0) {
        throw protocolError("OPEN service must not be empty.");
    }
    if (serviceLength > FRAME_MAX_OPEN_SERVICE_SIZE) {
        throw protocolError(
            `OPEN service exceeds ${FRAME_MAX_OPEN_SERVICE_SIZE} bytes.`,
            "protocol.frameTooLarge",
        );
    }
    const serviceEnd = OPEN_FIXED_SIZE + serviceLength;
    if (serviceEnd > payload.byteLength) {
        throw protocolError("OPEN service length exceeds payload length.");
    }
    const service = decodeUtf8(
        payload.subarray(OPEN_FIXED_SIZE, serviceEnd),
        "OPEN service",
    );
    const metadataLength = payload.byteLength - serviceEnd;
    if (metadataLength > FRAME_MAX_OPEN_METADATA_SIZE) {
        throw protocolError(
            `OPEN metadata exceeds ${FRAME_MAX_OPEN_METADATA_SIZE} bytes.`,
            "protocol.frameTooLarge",
        );
    }
    return {
        type: "open",
        streamId,
        receiveWindow,
        service,
        metadata: payload.slice(serviceEnd),
    };
}

function typeCode(type: Frame["type"]): number {
    switch (type) {
        case "open":
            return FrameType.Open;
        case "data":
            return FrameType.Data;
        case "window":
            return FrameType.Window;
        case "fin":
            return FrameType.Fin;
        case "reset":
            return FrameType.Reset;
    }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
    try {
        return decoder.decode(bytes);
    } catch {
        throw protocolError(`${label} must be valid UTF-8.`);
    }
}

function assertStreamId(value: number): void {
    if (!Number.isInteger(value) || value <= 0 || value > UINT32_MAX) {
        throw protocolError("Frame streamId must be a positive u32.");
    }
}

function assertPositiveU32(value: number, label: string): void {
    if (!Number.isInteger(value) || value <= 0 || value > UINT32_MAX) {
        throw protocolError(`${label} must be a positive u32.`);
    }
}

function assertU16(value: number, label: string): void {
    if (!Number.isInteger(value) || value <= 0 || value > UINT16_MAX) {
        throw protocolError(`${label} must be a positive u16.`);
    }
}

function assertPacketSize(size: number, maxPacketSize: number): void {
    if (size > maxPacketSize) {
        throw protocolError(
            `Frame payload exceeds ${maxPacketSize} bytes.`,
            "protocol.frameTooLarge",
        );
    }
}

function readU16(bytes: Uint8Array, offset: number): number {
    return view(bytes).getUint16(offset, false);
}

function readU32(bytes: Uint8Array, offset: number): number {
    return view(bytes).getUint32(offset, false);
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
    view(bytes).setUint16(offset, value, false);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
    view(bytes).setUint32(offset, value, false);
}

function view(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function protocolError(message: string, code = "protocol.invalidFrame"): Error {
    return createError({ code: code as ErrorCode, message, retryable: false });
}
