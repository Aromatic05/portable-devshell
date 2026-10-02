import {
    TRANSPORT_PROTOCOL_FRAME_TOO_LARGE_CODE,
    TRANSPORT_PROTOCOL_INVALID_FRAME_CODE,
} from "../primitive/Error.js";

const LENGTH_SIZE = 4;
const FRAME_HEADER_SIZE = 6;
const OPEN_FIXED_SIZE = 6;
const WINDOW_SIZE = 4;
const RESET_CODE_SIZE = 2;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

const FRAME_WIRE_FORMAT_VERSION = 1;
export const FRAME_PROTOCOL_VERSION = "1.0.0";
export const FRAME_PROTOCOL_RANGE = Object.freeze({
    max: FRAME_PROTOCOL_VERSION,
    min: FRAME_PROTOCOL_VERSION,
});
export const FRAME_MAX_DATA_SIZE = 64 * 1024;
export const FRAME_MAX_METADATA_SIZE = 64 * 1024;
export const FRAME_MAX_SERVICE_SIZE = 256;
export const FRAME_MAX_ERROR_SIZE = 64 * 1024;
const FRAME_MAX_BODY_SIZE =
    FRAME_HEADER_SIZE +
    Math.max(
        FRAME_MAX_DATA_SIZE,
        OPEN_FIXED_SIZE + FRAME_MAX_SERVICE_SIZE + FRAME_MAX_METADATA_SIZE,
        RESET_CODE_SIZE + FRAME_MAX_ERROR_SIZE,
    );

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

export class FrameBuffer {
    #buffer = new Uint8Array(1024);
    #end = 0;
    #start = 0;

    get empty(): boolean {
        return this.#start === this.#end;
    }

    push(chunk: Uint8Array): Frame[] {
        if (chunk.byteLength === 0) return [];
        this.#append(chunk);
        const frames: Frame[] = [];
        while (this.#end - this.#start >= LENGTH_SIZE) {
            const length = readU32(this.#buffer, this.#start);
            assertFrameSize(length);
            if (this.#end - this.#start < LENGTH_SIZE + length) break;
            const bodyStart = this.#start + LENGTH_SIZE;
            frames.push(
                decodeFrameBody(
                    this.#buffer.subarray(bodyStart, bodyStart + length),
                ),
            );
            this.#start += LENGTH_SIZE + length;
        }
        if (this.#start === this.#end) {
            this.#start = 0;
            this.#end = 0;
        }
        return frames;
    }

    reset(): void {
        this.#start = 0;
        this.#end = 0;
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

export function encodeFrame(frame: Frame): Uint8Array {
    assertStreamId(frame.streamId);
    let payload: Uint8Array;
    switch (frame.type) {
        case "open":
            payload = encodeOpen(frame);
            break;
        case "data":
            if (frame.data.byteLength > FRAME_MAX_DATA_SIZE)
                throw frameTooLarge("DATA", FRAME_MAX_DATA_SIZE);
            payload = frame.data;
            break;
        case "window":
            assertPositiveU32(frame.creditDelta, "WINDOW credit");
            payload = new Uint8Array(WINDOW_SIZE);
            writeU32(payload, 0, frame.creditDelta);
            break;
        case "fin":
            payload = new Uint8Array();
            break;
        case "reset": {
            assertU16(frame.code, "RESET code");
            const message = encoder.encode(frame.message);
            if (message.byteLength > FRAME_MAX_ERROR_SIZE)
                throw frameTooLarge("RESET message", FRAME_MAX_ERROR_SIZE);
            payload = new Uint8Array(RESET_CODE_SIZE + message.byteLength);
            writeU16(payload, 0, frame.code);
            payload.set(message, RESET_CODE_SIZE);
            break;
        }
    }

    const body = new Uint8Array(FRAME_HEADER_SIZE + payload.byteLength);
    body[0] = FRAME_WIRE_FORMAT_VERSION;
    body[1] = typeCode(frame.type);
    writeU32(body, 2, frame.streamId);
    body.set(payload, FRAME_HEADER_SIZE);
    assertFrameSize(body.byteLength);
    const encoded = new Uint8Array(LENGTH_SIZE + body.byteLength);
    writeU32(encoded, 0, body.byteLength);
    encoded.set(body, LENGTH_SIZE);
    return encoded;
}

export function decodeFrame(encoded: Uint8Array): Frame {
    if (encoded.byteLength < LENGTH_SIZE) throw protocolError("Frame length is missing.");
    const length = readU32(encoded, 0);
    assertFrameSize(length);
    if (encoded.byteLength !== LENGTH_SIZE + length)
        throw protocolError("Frame length does not match payload length.");
    return decodeFrameBody(encoded.subarray(LENGTH_SIZE));
}

function encodeOpen(frame: Extract<Frame, { type: "open" }>): Uint8Array {
    assertPositiveU32(frame.receiveWindow, "OPEN receive window");
    const service = encoder.encode(frame.service);
    if (service.byteLength === 0 || service.byteLength > FRAME_MAX_SERVICE_SIZE)
        throw protocolError("OPEN service must be a non-empty UTF-8 name.");
    if (frame.metadata.byteLength > FRAME_MAX_METADATA_SIZE)
        throw frameTooLarge("OPEN metadata", FRAME_MAX_METADATA_SIZE);
    const payload = new Uint8Array(
        OPEN_FIXED_SIZE + service.byteLength + frame.metadata.byteLength,
    );
    writeU32(payload, 0, frame.receiveWindow);
    writeU16(payload, 4, service.byteLength);
    payload.set(service, OPEN_FIXED_SIZE);
    payload.set(frame.metadata, OPEN_FIXED_SIZE + service.byteLength);
    return payload;
}

function decodeFrameBody(body: Uint8Array): Frame {
    if (body.byteLength < FRAME_HEADER_SIZE)
        throw protocolError("Frame header is incomplete.");
    if (body[0] !== FRAME_WIRE_FORMAT_VERSION)
        throw protocolError(`Unsupported Frame wire format ${body[0]}.`);
    const streamId = readU32(body, 2);
    assertStreamId(streamId);
    const payload = body.subarray(FRAME_HEADER_SIZE);

    switch (body[1]) {
        case FrameType.Open:
            return decodeOpen(streamId, payload);
        case FrameType.Data:
            if (payload.byteLength > FRAME_MAX_DATA_SIZE)
                throw frameTooLarge("DATA", FRAME_MAX_DATA_SIZE);
            return { type: "data", streamId, data: Uint8Array.from(payload) };
        case FrameType.Window: {
            if (payload.byteLength !== WINDOW_SIZE)
                throw protocolError("WINDOW payload must be exactly 4 bytes.");
            const creditDelta = readU32(payload, 0);
            assertPositiveU32(creditDelta, "WINDOW credit");
            return { type: "window", streamId, creditDelta };
        }
        case FrameType.Fin:
            if (payload.byteLength !== 0)
                throw protocolError("FIN payload must be empty.");
            return { type: "fin", streamId };
        case FrameType.Reset: {
            if (payload.byteLength < RESET_CODE_SIZE)
                throw protocolError("RESET payload is incomplete.");
            const code = readU16(payload, 0);
            assertU16(code, "RESET code");
            const message = payload.subarray(RESET_CODE_SIZE);
            if (message.byteLength > FRAME_MAX_ERROR_SIZE)
                throw frameTooLarge("RESET message", FRAME_MAX_ERROR_SIZE);
            return {
                type: "reset",
                streamId,
                code,
                message: decodeUtf8(message, "RESET message"),
            };
        }
        default:
            throw protocolError(`Unknown Frame type ${String(body[1])}.`);
    }
}

function decodeOpen(streamId: number, payload: Uint8Array): Frame {
    if (payload.byteLength < OPEN_FIXED_SIZE)
        throw protocolError("OPEN payload is incomplete.");
    const receiveWindow = readU32(payload, 0);
    assertPositiveU32(receiveWindow, "OPEN receive window");
    const serviceLength = readU16(payload, 4);
    if (serviceLength === 0 || serviceLength > FRAME_MAX_SERVICE_SIZE)
        throw protocolError("OPEN service length is invalid.");
    const serviceEnd = OPEN_FIXED_SIZE + serviceLength;
    if (serviceEnd > payload.byteLength)
        throw protocolError("OPEN service length exceeds payload length.");
    const metadata = payload.subarray(serviceEnd);
    if (metadata.byteLength > FRAME_MAX_METADATA_SIZE)
        throw frameTooLarge("OPEN metadata", FRAME_MAX_METADATA_SIZE);
    return {
        type: "open",
        streamId,
        receiveWindow,
        service: decodeUtf8(payload.subarray(OPEN_FIXED_SIZE, serviceEnd), "OPEN service"),
        metadata: Uint8Array.from(metadata),
    };
}

function typeCode(type: Frame["type"]): number {
    return {
        open: FrameType.Open,
        data: FrameType.Data,
        window: FrameType.Window,
        fin: FrameType.Fin,
        reset: FrameType.Reset,
    }[type];
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
    try {
        return decoder.decode(bytes);
    } catch {
        throw protocolError(`${label} must be valid UTF-8.`);
    }
}

function assertStreamId(value: number): void {
    if (!Number.isInteger(value) || value <= 0 || value > UINT32_MAX)
        throw protocolError("Frame streamId must be a positive u32.");
}

function assertPositiveU32(value: number, label: string): void {
    if (!Number.isInteger(value) || value <= 0 || value > UINT32_MAX)
        throw protocolError(`${label} must be a positive u32.`);
}

function assertU16(value: number, label: string): void {
    if (!Number.isInteger(value) || value <= 0 || value > UINT16_MAX)
        throw protocolError(`${label} must be a positive u16.`);
}

function assertFrameSize(size: number): void {
    if (size > FRAME_MAX_BODY_SIZE)
        throw frameTooLarge("Frame", FRAME_MAX_BODY_SIZE);
}

function frameTooLarge(label: string, max: number): Error {
    return protocolError(
        `${label} exceeds ${max} bytes.`,
        TRANSPORT_PROTOCOL_FRAME_TOO_LARGE_CODE,
    );
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

function protocolError(
    message: string,
    code = TRANSPORT_PROTOCOL_INVALID_FRAME_CODE,
): Error {
    return Object.assign(new Error(message), { code, retryable: false });
}
