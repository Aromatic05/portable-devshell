import type { ErrorCode } from "../../protocol/Error.js";
import { createError } from "../../protocol/Error.js";

const FRAME_HEADER_SIZE = 4;
export const TRANSPORT_MAX_FRAME_SIZE = 16 * 1024 * 1024;

export type Frame = Uint8Array;

export class FrameBuffer {
    readonly #maxFrameSize: number;
    #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

    constructor(maxFrameSize = TRANSPORT_MAX_FRAME_SIZE) {
        this.#maxFrameSize = maxFrameSize;
    }

    get empty(): boolean {
        return this.#buffer.byteLength === 0;
    }

    push(chunk: Uint8Array): Frame[] {
        if (chunk.byteLength === 0) {
            return [];
        }
        this.#buffer = appendBytes(this.#buffer, chunk);
        const frames: Frame[] = [];
        while (this.#buffer.byteLength >= FRAME_HEADER_SIZE) {
            const payloadLength = readU32(this.#buffer, 0);
            assertFrameSize(payloadLength, this.#maxFrameSize);
            const frameLength = FRAME_HEADER_SIZE + payloadLength;
            if (this.#buffer.byteLength < frameLength) {
                break;
            }
            frames.push(this.#buffer.slice(FRAME_HEADER_SIZE, frameLength));
            this.#buffer = this.#buffer.slice(frameLength);
        }
        return frames;
    }

    reset(): void {
        this.#buffer = new Uint8Array();
    }
}

export function encodeFrame(
    payload: Uint8Array,
    maxFrameSize = TRANSPORT_MAX_FRAME_SIZE,
): Uint8Array {
    assertFrameSize(payload.byteLength, maxFrameSize);
    const frame = new Uint8Array(FRAME_HEADER_SIZE + payload.byteLength);
    writeU32(frame, 0, payload.byteLength);
    frame.set(payload, FRAME_HEADER_SIZE);
    return frame;
}

export function decodeFrame(
    frame: Uint8Array,
    maxFrameSize = TRANSPORT_MAX_FRAME_SIZE,
): Uint8Array {
    if (frame.byteLength < FRAME_HEADER_SIZE) {
        throw protocolError(
            "protocol.invalidFrame",
            "Frame header is incomplete.",
        );
    }
    const payloadLength = readU32(frame, 0);
    assertFrameSize(payloadLength, maxFrameSize);
    if (frame.byteLength !== FRAME_HEADER_SIZE + payloadLength) {
        throw protocolError(
            "protocol.invalidFrame",
            "Frame length does not match payload length.",
        );
    }
    return frame.slice(FRAME_HEADER_SIZE);
}

function appendBytes(current: Uint8Array, next: Uint8Array): Uint8Array {
    if (current.byteLength === 0) return Uint8Array.from(next);
    const combined = new Uint8Array(current.byteLength + next.byteLength);
    combined.set(current, 0);
    combined.set(next, current.byteLength);
    return combined;
}

function readU32(bytes: Uint8Array, offset: number): number {
    return new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
    ).getUint32(offset, false);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
        offset,
        value,
        false,
    );
}

function assertFrameSize(size: number, maxFrameSize: number): void {
    if (size > maxFrameSize) {
        throw protocolError(
            "protocol.frameTooLarge",
            `Frame payload exceeds ${maxFrameSize} bytes.`,
        );
    }
}

function protocolError(code: string, message: string): Error {
    return createError({ code: code as ErrorCode, message, retryable: false });
}
