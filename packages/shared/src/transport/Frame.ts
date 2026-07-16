import type { ErrorCode } from "../error/ErrorCodeCatalog.js";
import { createError } from "../error/ErrorFactoryCreate.js";

const FRAME_HEADER_SIZE = 4;
export const TRANSPORT_MAX_FRAME_SIZE = 16 * 1024 * 1024;

export type Frame = Uint8Array;

export class FrameBuffer {
    readonly #maxFrameSize: number;
    #buffer = Buffer.alloc(0);

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
        const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.#buffer = this.#buffer.byteLength === 0
            ? Buffer.from(normalized)
            : Buffer.concat([this.#buffer, normalized]);
        const frames: Frame[] = [];
        while (this.#buffer.byteLength >= FRAME_HEADER_SIZE) {
            const payloadLength = this.#buffer.readUInt32BE(0);
            assertFrameSize(payloadLength, this.#maxFrameSize);
            const frameLength = FRAME_HEADER_SIZE + payloadLength;
            if (this.#buffer.byteLength < frameLength) {
                break;
            }
            frames.push(Buffer.from(this.#buffer.subarray(FRAME_HEADER_SIZE, frameLength)));
            this.#buffer = this.#buffer.subarray(frameLength);
        }
        return frames;
    }

    reset(): void {
        this.#buffer = Buffer.alloc(0);
    }
}

export function encodeFrame(payload: Uint8Array, maxFrameSize = TRANSPORT_MAX_FRAME_SIZE): Buffer {
    const normalized = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    assertFrameSize(normalized.byteLength, maxFrameSize);
    const frame = Buffer.allocUnsafe(FRAME_HEADER_SIZE + normalized.byteLength);
    frame.writeUInt32BE(normalized.byteLength, 0);
    normalized.copy(frame, FRAME_HEADER_SIZE);
    return frame;
}

export function decodeFrame(frame: Uint8Array, maxFrameSize = TRANSPORT_MAX_FRAME_SIZE): Buffer {
    const normalized = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    if (normalized.byteLength < FRAME_HEADER_SIZE) {
        throw protocolError("protocol.invalidFrame", "Frame header is incomplete.");
    }
    const payloadLength = normalized.readUInt32BE(0);
    assertFrameSize(payloadLength, maxFrameSize);
    if (normalized.byteLength !== FRAME_HEADER_SIZE + payloadLength) {
        throw protocolError("protocol.invalidFrame", "Frame length does not match payload length.");
    }
    return Buffer.from(normalized.subarray(FRAME_HEADER_SIZE));
}

function assertFrameSize(size: number, maxFrameSize: number): void {
    if (size > maxFrameSize) {
        throw protocolError("protocol.frameTooLarge", `Frame payload exceeds ${maxFrameSize} bytes.`);
    }
}

function protocolError(code: string, message: string): Error {
    return createError({ code: code as ErrorCode, message, retryable: false });
}
